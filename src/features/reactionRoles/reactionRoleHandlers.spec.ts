import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionsBitField, PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";
import {
  handleReactionRoleButton,
  handleReactionRoleModal,
  hasDangerousReactionRolePermission,
  parseToggleCustomId,
  validateAssignableReactionRoles,
} from "./reactionRoleHandlers.js";

function makeRole(id: string, name: string, position: number, perms: bigint[] = [], managed = false) {
  return {
    id,
    name,
    position,
    managed,
    permissions: new PermissionsBitField(perms),
  };
}

function makeGuildFixture(options: {
  ownerId?: string;
  botHighestPos?: number;
  roles: ReturnType<typeof makeRole>[];
}) {
  const roleMap = new Map(options.roles.map((r) => [r.id, r]));
  const guild = {
    id: "guild-1",
    ownerId: options.ownerId ?? "owner-1",
    members: {
      me: {
        permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
        roles: { highest: { position: options.botHighestPos ?? 50 } },
      },
      fetchMe: async () => undefined,
    },
    roles: {
      cache: roleMap,
      fetch: async (id: string) => roleMap.get(id) ?? null,
    },
  } as unknown as Guild;
  return guild;
}

function makeActor(id: string, highestPosition: number): GuildMember {
  return {
    id,
    roles: { highest: { position: highestPosition } },
  } as unknown as GuildMember;
}

test("hasDangerousReactionRolePermission flags privileged permissions and allows normal roles", () => {
  const dangerousPerms = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.MentionEveryone,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageNicknames,
    PermissionFlagsBits.ManageGuildExpressions,
    PermissionFlagsBits.ManageEvents,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.ViewAuditLog,
  ];
  for (const [idx, perm] of dangerousPerms.entries()) {
    assert.equal(
      hasDangerousReactionRolePermission(makeRole(String(idx + 1), `Dangerous-${idx}`, 10, [perm])),
      true,
    );
  }
  assert.equal(hasDangerousReactionRolePermission(makeRole("99", "Member", 5, [PermissionFlagsBits.SendMessages])), false);
});

test("validateAssignableReactionRoles blocks roles at or above actor highest role for non-owners", async () => {
  const guild = makeGuildFixture({
    roles: [
      makeRole("100", "LowerRole", 5),
      makeRole("200", "EqualRole", 10),
      makeRole("300", "HigherRole", 20),
    ],
  });
  const mod = makeActor("mod-1", 10);

  assert.equal(await validateAssignableReactionRoles(guild, mod, ["100"]), null);
  assert.match((await validateAssignableReactionRoles(guild, mod, ["200"])) ?? "", /自身の最上位ロール以上/);
  assert.match((await validateAssignableReactionRoles(guild, mod, ["300"])) ?? "", /自身の最上位ロール以上/);
});

test("validateAssignableReactionRoles exempts guild owner from actor hierarchy but still blocks dangerous roles", async () => {
  const guild = makeGuildFixture({
    ownerId: "owner-1",
    botHighestPos: 50,
    roles: [
      makeRole("100", "HighNormalRole", 40),
      makeRole("200", "AdminRole", 10, [PermissionFlagsBits.Administrator]),
      makeRole("300", "AboveBotRole", 60),
    ],
  });
  const owner = makeActor("owner-1", 1);

  assert.equal(await validateAssignableReactionRoles(guild, owner, ["100"]), null);
  assert.match((await validateAssignableReactionRoles(guild, owner, ["200"])) ?? "", /危険な権限/);
  assert.match((await validateAssignableReactionRoles(guild, owner, ["300"])) ?? "", /Bot の最上位ロール以上/);
});

test("parseToggleCustomId extracts entryId and roleId", () => {
  assert.deepEqual(parseToggleCustomId("reaction_role:rr_123:987654321"), {
    entryId: "rr_123",
    roleId: "987654321",
  });
  assert.equal(parseToggleCustomId("reaction_role:invalid"), null);
  assert.equal(parseToggleCustomId("other:rr_123:987654321"), null);
});

test("handleReactionRoleButton rejects role toggle when roleId is not registered in entry", async () => {
  const replies: string[] = [];
  const interaction = {
    customId: "reaction_role:rr_1:999999999999999999",
    guild: {
      id: "guild-1",
      roles: { cache: new Map(), fetch: async () => null },
    },
    user: { id: "user-1" },
    replied: false,
    deferred: false,
    reply: async (opts: { content: string }) => {
      replies.push(opts.content);
    },
  };
  const fakeDb = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          where: () => ({
            executeTakeFirst: async () => ({
              entry_id: "rr_1",
              channel_id: "ch-1",
              message_id: "msg-1",
              title: "Roles",
              description: "",
              roles_json: JSON.stringify([{ roleId: "111111111111111111", label: "Allowed", emoji: null }]),
            }),
          }),
        }),
      }),
    }),
  };

  const handled = await handleReactionRoleButton(interaction as never, { db: fakeDb } as never);
  assert.equal(handled, true);
  assert.equal(replies.length, 1);
  assert.match(replies[0]!, /現在登録されていません/);
});

test("handleReactionRoleModal edit validates only newly added roleIds so admins can edit owner-created entries", async () => {
  const highRole = makeRole("111111111111111111", "OwnerOnlyRole", 30);
  const higherNewRole = makeRole("222222222222222222", "AnotherHighRole", 25);
  const mod = makeActor("mod-1", 10);

  const makeEditModalFixture = (rolesInput: string) => {
    const replies: string[] = [];
    let updatedRow = false;
    const roleMap = new Map([
      [highRole.id, highRole],
      [higherNewRole.id, higherNewRole],
    ]);
    const memberMap = new Map([[mod.id, mod]]);
    const channel = {
      isTextBased: () => true,
      isSendable: () => true,
      messages: {
        fetch: async () => ({
          id: "msg-1",
          author: { id: "bot-1" },
          edit: async () => ({ id: "msg-1" }),
        }),
      },
      send: async () => ({ id: "msg-1" }),
    };
    const guild = {
      id: "guild-1",
      ownerId: "owner-1",
      members: {
        me: {
          permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
          roles: { highest: { position: 50 } },
        },
        cache: memberMap,
        fetch: async (id: string) => memberMap.get(id) ?? null,
        fetchMe: async () => undefined,
      },
      roles: {
        cache: roleMap,
        fetch: async (id: string) => roleMap.get(id) ?? null,
      },
      channels: {
        cache: new Map([["123456789012345678", channel]]),
        fetch: async () => channel,
      },
      emojis: { cache: new Map(), fetch: async () => new Map() },
    };
    const fieldsMap: Record<string, string> = {
      channel_id: "",
      title: "Updated Title",
      description: "Updated Description",
      roles: rolesInput,
    };
    const interaction = {
      customId: "rr_admin_edit_modal:rr_1",
      guild,
      user: { id: mod.id },
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
      fields: {
        getTextInputValue: (key: string) => fieldsMap[key] ?? "",
      },
      replied: false,
      deferred: false,
      reply: async (opts: { content: string }) => {
        replies.push(opts.content);
      },
    };
    const fakeDb = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            where: () => ({
              executeTakeFirst: async () => ({
                entry_id: "rr_1",
                channel_id: "123456789012345678",
                message_id: "msg-1",
                title: "Old Title",
                description: "",
                roles_json: JSON.stringify([{ roleId: highRole.id, label: "VIP", emoji: null }]),
              }),
            }),
          }),
        }),
      }),
      updateTable: () => ({
        set: () => ({
          where: () => ({
            where: () => ({
              execute: async () => {
                updatedRow = true;
              },
            }),
          }),
        }),
      }),
    };
    return {
      interaction,
      ctx: { db: fakeDb, client: { user: { id: "bot-1" } }, log: { warn: () => undefined } },
      replies,
      wasUpdated: () => updatedRow,
    };
  };

  // Editing title/description with empty roles field succeeds even though existing role is above mod
  const editWithoutRoles = makeEditModalFixture("");
  await handleReactionRoleModal(editWithoutRoles.interaction as never, editWithoutRoles.ctx as never);
  assert.equal(editWithoutRoles.wasUpdated(), true);
  assert.match(editWithoutRoles.replies[0] ?? "", /更新しました/);

  // Adding a new role above mod's highest role is rejected
  const editAddingHighRole = makeEditModalFixture(`${highRole.id}|VIP\n${higherNewRole.id}|NewHigh`);
  await handleReactionRoleModal(editAddingHighRole.interaction as never, editAddingHighRole.ctx as never);
  assert.equal(editAddingHighRole.wasUpdated(), false);
  assert.match(editAddingHighRole.replies[0] ?? "", /自身の最上位ロール以上/);
});

test("handleReactionRoleButton blocks adding a dangerous role but allows removing it when bot hierarchy permits", async () => {
  const dangerousRole = makeRole("111111111111111111", "NowAdmin", 10, [PermissionFlagsBits.Administrator]);
  const aboveBotDangerousRole = makeRole("222222222222222222", "AboveBotAdmin", 60, [PermissionFlagsBits.Administrator]);

  const runToggle = async (role: ReturnType<typeof makeRole>, hasRole: boolean) => {
    const replies: string[] = [];
    const actions: string[] = [];
    const warns: unknown[][] = [];
    const roleMap = new Map([[role.id, role]]);
    const member = {
      id: "user-1",
      roles: {
        cache: new Map(hasRole ? [[role.id, role]] : []),
        add: async () => {
          actions.push("add");
        },
        remove: async () => {
          actions.push("remove");
        },
      },
    };
    const interaction = {
      customId: `reaction_role:rr_1:${role.id}`,
      guild: {
        id: "guild-1",
        members: {
          me: {
            permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
            roles: { highest: { position: 50 } },
          },
          fetchMe: async () => undefined,
          fetch: async () => member,
        },
        roles: {
          cache: roleMap,
          fetch: async (id: string) => roleMap.get(id) ?? null,
        },
      },
      user: { id: "user-1" },
      replied: false,
      deferred: false,
      reply: async (opts: { content: string }) => {
        replies.push(opts.content);
      },
    };
    const fakeDb = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            where: () => ({
              executeTakeFirst: async () => ({
                entry_id: "rr_1",
                channel_id: "ch-1",
                message_id: "msg-1",
                title: "Roles",
                description: "",
                roles_json: JSON.stringify([{ roleId: role.id, label: role.name, emoji: null }]),
              }),
            }),
          }),
        }),
      }),
    };
    await handleReactionRoleButton(
      interaction as never,
      {
        db: fakeDb,
        log: {
          warn: (...args: unknown[]) => {
            warns.push(args);
          },
        },
      } as never,
    );
    return { replies, actions, warns };
  };

  // Member does not have the dangerous role -> add is blocked with warn log and clear message
  const addAttempt = await runToggle(dangerousRole, false);
  assert.deepEqual(addAttempt.actions, []);
  assert.equal(
    addAttempt.replies[0],
    "このロールは強い権限を持つため、ボタンからは付与できません。サーバー管理者に連絡してください。",
  );
  assert.equal(addAttempt.warns.length, 1);
  assert.deepEqual(addAttempt.warns[0]?.[0], {
    guildId: "guild-1",
    entryId: "rr_1",
    roleId: dangerousRole.id,
    permissions: ["Administrator"],
  });

  // Member already has the dangerous role and bot is higher -> remove is allowed
  const removeAttempt = await runToggle(dangerousRole, true);
  assert.deepEqual(removeAttempt.actions, ["remove"]);
  assert.match(removeAttempt.replies[0] ?? "", /解除しました/);

  // Member has the dangerous role but bot hierarchy is insufficient -> remove is blocked
  const removeAboveBot = await runToggle(aboveBotDangerousRole, true);
  assert.deepEqual(removeAboveBot.actions, []);
  assert.match(removeAboveBot.replies[0] ?? "", /ロール階層が不足/);
});

test("handleReactionRoleModal edit appends warning notice when existing roles contain dangerous permissions", async () => {
  const dangerousExisting = makeRole("111111111111111111", "LegacyMod", 10, [
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.MentionEveryone,
  ]);
  const mod = makeActor("mod-1", 20);
  const replies: string[] = [];
  const roleMap = new Map([[dangerousExisting.id, dangerousExisting]]);
  const memberMap = new Map([[mod.id, mod]]);
  const channel = {
    isTextBased: () => true,
    isSendable: () => true,
    messages: {
      fetch: async () => ({
        id: "msg-1",
        author: { id: "bot-1" },
        edit: async () => ({ id: "msg-1" }),
      }),
    },
    send: async () => ({ id: "msg-1" }),
  };
  const interaction = {
    customId: "rr_admin_edit_modal:rr_legacy",
    guild: {
      id: "guild-1",
      ownerId: "owner-1",
      members: {
        me: {
          permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
          roles: { highest: { position: 50 } },
        },
        cache: memberMap,
        fetch: async (id: string) => memberMap.get(id) ?? null,
        fetchMe: async () => undefined,
      },
      roles: {
        cache: roleMap,
        fetch: async (id: string) => roleMap.get(id) ?? null,
      },
      channels: {
        cache: new Map([["123456789012345678", channel]]),
        fetch: async () => channel,
      },
      emojis: { cache: new Map(), fetch: async () => new Map() },
    },
    user: { id: mod.id },
    memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
    fields: {
      getTextInputValue: (key: string) => (key === "title" ? "Updated" : ""),
    },
    replied: false,
    deferred: false,
    reply: async (opts: { content: string }) => {
      replies.push(opts.content);
    },
  };
  const fakeDb = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          where: () => ({
            executeTakeFirst: async () => ({
              entry_id: "rr_legacy",
              channel_id: "123456789012345678",
              message_id: "msg-1",
              title: "Old",
              description: "",
              roles_json: JSON.stringify([{ roleId: dangerousExisting.id, label: "LegacyMod", emoji: null }]),
            }),
          }),
        }),
      }),
    }),
    updateTable: () => ({
      set: () => ({
        where: () => ({
          where: () => ({
            execute: async () => undefined,
          }),
        }),
      }),
    }),
  };

  await handleReactionRoleModal(
    interaction as never,
    { db: fakeDb, client: { user: { id: "bot-1" } }, log: { warn: () => undefined } } as never,
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0] ?? "", /更新しました。/);
  assert.match(replies[0] ?? "", /付与できないロール:/);
  assert.match(replies[0] ?? "", /LegacyMod/);
  assert.match(replies[0] ?? "", /MentionEveryone/);
  assert.match(replies[0] ?? "", /ManageMessages/);
});

test("handleReactionRoleModal create rejects dangerous roles before saving and creates normal roles without warning", async () => {
  const normalRole = makeRole("111111111111111111", "Member", 5, [PermissionFlagsBits.SendMessages]);
  const dangerousRole = makeRole("222222222222222222", "AdminRole", 10, [PermissionFlagsBits.Administrator]);
  const mod = makeActor("mod-1", 20);

  const runCreate = async (rolesInput: string) => {
    const replies: string[] = [];
    let inserted = false;
    const roleMap = new Map([
      [normalRole.id, normalRole],
      [dangerousRole.id, dangerousRole],
    ]);
    const memberMap = new Map([[mod.id, mod]]);
    const channel = {
      isTextBased: () => true,
      isSendable: () => true,
      messages: { fetch: async () => ({ find: () => undefined }) },
      send: async () => ({ id: "msg-new" }),
    };
    const fieldsMap: Record<string, string> = {
      channel_id: "123456789012345678",
      title: "Roles",
      description: "Pick a role",
      roles: rolesInput,
    };
    const interaction = {
      customId: "rr_admin_create_modal",
      guild: {
        id: "guild-1",
        ownerId: "owner-1",
        members: {
          me: {
            permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
            roles: { highest: { position: 50 } },
          },
          cache: memberMap,
          fetch: async (id: string) => memberMap.get(id) ?? null,
          fetchMe: async () => undefined,
        },
        roles: {
          cache: roleMap,
          fetch: async (id: string) => roleMap.get(id) ?? null,
        },
        channels: {
          cache: new Map([["123456789012345678", channel]]),
          fetch: async () => channel,
        },
        emojis: { cache: new Map(), fetch: async () => new Map() },
      },
      user: { id: mod.id },
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
      fields: {
        getTextInputValue: (key: string) => fieldsMap[key] ?? "",
      },
      replied: false,
      deferred: false,
      reply: async (opts: { content: string }) => {
        replies.push(opts.content);
      },
    };
    const fakeDb = {
      insertInto: () => ({
        values: () => ({
          execute: async () => {
            inserted = true;
          },
        }),
      }),
    };
    await handleReactionRoleModal(
      interaction as never,
      { db: fakeDb, client: { user: { id: "bot-1" } }, log: { warn: () => undefined } } as never,
    );
    return { replies, inserted };
  };

  const blocked = await runCreate(`${dangerousRole.id}|Admin`);
  assert.equal(blocked.inserted, false);
  assert.match(blocked.replies[0] ?? "", /危険な権限/);

  const created = await runCreate(`${normalRole.id}|Member`);
  assert.equal(created.inserted, true);
  assert.match(created.replies[0] ?? "", /^リアクションロールを作成しました。entry_id=rr_/);
  assert.doesNotMatch(created.replies[0] ?? "", /付与できないロール/);
});
