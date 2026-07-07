import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { BotContext } from "../../bot/context.js";
import { deepseekChat, type ChatMessage } from "./deepseek.js";
import { AiQueryService } from "./aiQueryService.js";

const MODAL_ID = "ai_create_prompt:modal";
const FIELD_NAME = "name";
const FIELD_GENDER = "gender";
const FIELD_AGE = "age";
const FIELD_TARGET = "target";
const FIELD_DETAILS = "details";
const BUTTON_PREFIX = "ai_create_prompt:";
const MODEL = "deepseek-v4-pro";

type PromptConditions = {
  name?: string;
  gender?: "男" | "女";
  age?: number;
  target?: "男" | "女";
  details?: string;
};

type PromptSession = {
  ownerId: string;
  ownerName: string;
  guildId: string;
  conditions: PromptConditions;
  prompt: string;
  previousPrompts: string[];
  createdAt: number;
};

const sessions = new Map<string, PromptSession>();

function clean(text: string): string {
  return String(text || "").trim();
}

function normalizeBinaryChoice(value: string): "男" | "女" | null {
  const v = clean(value);
  if (!v) return null;
  if (["男", "男性", "male", "man", "m"].includes(v.toLowerCase())) return "男";
  if (["女", "女性", "female", "woman", "f"].includes(v.toLowerCase())) return "女";
  return null;
}

function normalizeAge(value: string): number | null {
  const v = clean(value);
  if (!v) return null;
  if (!/^\d+$/.test(v)) return NaN;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 18 || n > 100) return NaN;
  return n;
}

function hasAnyCondition(c: PromptConditions): boolean {
  return Boolean(c.name || c.gender || c.age || c.target || c.details);
}

function conditionLines(c: PromptConditions): string[] {
  return [
    `名前: ${c.name ?? "ランダム"}`,
    `性別: ${c.gender ?? "ランダム"}`,
    `年齢: ${c.age ?? "ランダム（18歳以上）"}`,
    `性的対象: ${c.target ?? "ランダム"}`,
    `詳細: ${c.details ?? "ランダム"}`,
  ];
}

function buildModal(prefill?: PromptConditions): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle("AIプロンプト作成")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_NAME)
          .setLabel("名前（任意）")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(80)
          .setValue(prefill?.name ?? ""),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_GENDER)
          .setLabel("性別（任意: 男 / 女）")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setValue(prefill?.gender ?? ""),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_AGE)
          .setLabel("年齢（任意: 18-100）")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(3)
          .setValue(prefill?.age ? String(prefill.age) : ""),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_TARGET)
          .setLabel("性的対象（任意: 男 / 女）")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setValue(prefill?.target ?? ""),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_DETAILS)
          .setLabel("その他 キャラクターの詳細設定（任意）")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1500)
          .setValue(prefill?.details ?? ""),
      ),
    );
}

export async function showCreatePromptModal(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.showModal(buildModal());
}

function parseConditions(interaction: ModalSubmitInteraction): { ok: true; conditions: PromptConditions } | { ok: false; error: string } {
  const name = clean(interaction.fields.getTextInputValue(FIELD_NAME)).slice(0, 80);
  const genderRaw = interaction.fields.getTextInputValue(FIELD_GENDER);
  const ageRaw = interaction.fields.getTextInputValue(FIELD_AGE);
  const targetRaw = interaction.fields.getTextInputValue(FIELD_TARGET);
  const details = clean(interaction.fields.getTextInputValue(FIELD_DETAILS)).slice(0, 1500);

  const gender = normalizeBinaryChoice(genderRaw);
  if (clean(genderRaw) && !gender) {
    return { ok: false, error: "性別は `男` または `女` で入力してください。" };
  }

  const target = normalizeBinaryChoice(targetRaw);
  if (clean(targetRaw) && !target) {
    return { ok: false, error: "性的対象は `男` または `女` で入力してください。" };
  }

  const age = normalizeAge(ageRaw);
  if (Number.isNaN(age)) {
    return { ok: false, error: "年齢は 18 以上 100 以下の整数で入力してください。" };
  }

  return {
    ok: true,
    conditions: {
      ...(name ? { name } : {}),
      ...(gender ? { gender } : {}),
      ...(age ? { age } : {}),
      ...(target ? { target } : {}),
      ...(details ? { details } : {}),
    },
  };
}

function buildGeneratorMessages(conditions: PromptConditions, previousPrompts: string[]): ChatMessage[] {
  const randomMode = !hasAnyCondition(conditions);
  const previousBlock = previousPrompts.length
    ? [
        "Avoid producing a prompt with the same core persona, personality, relationship style, speech pattern, job, hobbies, or scenario as these previous attempts:",
        previousPrompts.map((p, i) => `[Previous ${i + 1}]\n${p.slice(0, 2400)}`).join("\n\n"),
      ].join("\n")
    : "";

  return [
    {
      role: "system",
      content: [
        "You create Japanese system prompts for a Discord /q assistant.",
        "Return only the finished system prompt text. Do not wrap it in markdown or explanations.",
        "The prompt must be safe for an adult general-audience Discord bot. Do not write explicit sexual content.",
        "The character must be 18 or older.",
        "If the user supplied any fields, reflect them exactly and do not contradict them.",
        "Persona fields such as name, gender, age, orientation, and detailed character settings must be written as stable reference material for the assistant.",
        "Instruct the assistant to use those persona fields as internal context, not to repeatedly announce them unless naturally relevant.",
        "Include a clear rule that conversation history must not overwrite or drift away from the persona fields.",
        "Make the prompt practical, concrete, and ready to use as a system prompt.",
        "Keep it under 3000 Japanese characters.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        randomMode
          ? "All fields are blank. Create a fully random adult character prompt."
          : "Create a character prompt from these user-supplied fields.",
        "",
        "[Required Conditions]",
        conditionLines(conditions).join("\n"),
        "",
        previousBlock,
      ].join("\n").trim(),
    },
  ];
}

async function generatePrompt(ctx: BotContext, conditions: PromptConditions, previousPrompts: string[]): Promise<string> {
  const { content } = await deepseekChat(ctx.config, buildGeneratorMessages(conditions, previousPrompts), {
    model: MODEL,
    thinking: true,
    sanitizeOutput: false,
    timeoutMs: Math.max(ctx.config.AI_REQUEST_TIMEOUT_MS, 60_000),
  });
  return clean(content);
}

function createSession(session: Omit<PromptSession, "createdAt">): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 16);
  sessions.set(id, { ...session, createdAt: Date.now() });
  if (sessions.size > 200) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, value] of sessions) {
      if (value.createdAt < cutoff) sessions.delete(key);
    }
  }
  return id;
}

function updateSession(id: string, patch: Partial<PromptSession>): PromptSession | null {
  const cur = sessions.get(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, createdAt: Date.now() };
  sessions.set(id, next);
  return next;
}

function buildPromptEmbed(session: PromptSession): ComponentCardBuilder {
  const embed = new ComponentCardBuilder()
    .setTitle("作成した /q プロンプト")
    .setColor(0x8e44ad)
    .setDescription(session.prompt.slice(0, 4000))
    .addFields({ name: "生成条件", value: conditionLines(session.conditions).join("\n").slice(0, 1024) });
  if (session.prompt.length > 4000) {
    embed.setFooter({ text: "プロンプトが長いため一部のみ表示しています。保存ボタンでは全文を取得できます。" });
  }
  return embed;
}

function buildPromptRows(id: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}use:${id}`)
        .setLabel("このプロンプトを使用する")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}txt:${id}`)
        .setLabel("txt形式で保存")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}md:${id}`)
        .setLabel("md形式で保存")
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}retry:${id}`)
        .setLabel("同じ条件で再考させる")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}restart:${id}`)
        .setLabel("最初からやり直す")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function parseButtonId(customId: string): { action: string; id: string } | null {
  if (!customId.startsWith(BUTTON_PREFIX)) return null;
  const [, action, id] = customId.split(":");
  if (!action || !id) return null;
  return { action, id };
}

function createAttachment(prompt: string, ext: "txt" | "md"): AttachmentBuilder {
  const name = `ai_prompt_${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
  const body = ext === "md" ? `# /q AI Prompt\n\n${prompt}\n` : `${prompt}\n`;
  return new AttachmentBuilder(Buffer.from(body, "utf8"), { name });
}

export async function handleCreatePromptModalSubmit(
  interaction: ModalSubmitInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId !== MODAL_ID) return false;
  if (!interaction.inGuild() || interaction.guildId !== ctx.config.GUILD_ID) {
    await interaction.reply({ content: "このサーバーでは利用できません。", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return true;
  }

  const parsed = parseConditions(interaction);
  if (!parsed.ok) {
    await interaction.reply({ content: parsed.error, flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferReply();
  try {
    const prompt = await generatePrompt(ctx, parsed.conditions, []);
    if (!prompt) throw new Error("empty prompt");
    const id = createSession({
      ownerId: interaction.user.id,
      ownerName: interaction.user.username,
      guildId: interaction.guildId!,
      conditions: parsed.conditions,
      prompt,
      previousPrompts: [prompt],
    });
    const session = sessions.get(id)!;
    await interaction.editReply({
      ...componentCardsPayload([buildPromptEmbed(session)], buildPromptRows(id)),
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    ctx.log.error({ err }, "create_prompt generation failed");
    await interaction.editReply({ content: "プロンプト作成に失敗しました。しばらくしてから再度お試しください。" });
  }
  return true;
}

export async function handleCreatePromptButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const parsed = parseButtonId(interaction.customId);
  if (!parsed) return false;

  const session = sessions.get(parsed.id);
  if (!session) {
    await interaction.reply({ content: "このプロンプト作成セッションは期限切れです。もう一度 /create_prompt を実行してください。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.user.id !== session.ownerId) {
    await interaction.reply({ content: "このボタンはプロンプトを作成したユーザーのみ利用できます。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.guildId !== session.guildId) {
    await interaction.reply({ content: "このボタンは別サーバー用です。", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (parsed.action === "use") {
    const svc = new AiQueryService(ctx);
    svc.replaceUserPromptFromChangePromptCommand(session.ownerId, session.ownerName, session.prompt);
    await interaction.reply({ content: "このプロンプトをあなたの /q に適用しました。", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (parsed.action === "txt" || parsed.action === "md") {
    const ext = parsed.action === "txt" ? "txt" : "md";
    await interaction.reply({
      content: `${ext}形式で保存しました。`,
      files: [createAttachment(session.prompt, ext)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (parsed.action === "restart") {
    await interaction.showModal(buildModal());
    return true;
  }

  if (parsed.action === "retry") {
    await interaction.deferUpdate();
    try {
      const prompt = await generatePrompt(ctx, session.conditions, session.previousPrompts);
      if (!prompt) throw new Error("empty prompt");
      const next = updateSession(parsed.id, {
        prompt,
        previousPrompts: [...session.previousPrompts, prompt].slice(-5),
      });
      if (!next) throw new Error("missing session after update");
      await interaction.editReply({
        ...componentCardsPayload([buildPromptEmbed(next)], buildPromptRows(parsed.id)),
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      ctx.log.error({ err }, "create_prompt retry failed");
      await interaction.followUp({
        content: "再生成に失敗しました。しばらくしてから再度お試しください。",
        flags: MessageFlags.Ephemeral,
      });
    }
    return true;
  }

  return false;
}
