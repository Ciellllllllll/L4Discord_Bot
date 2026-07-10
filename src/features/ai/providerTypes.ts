export type AiProvider = "openai" | "deepseek";

export type OpenAiModelPreference = "gpt56" | "gpt54_mini";

export type AiRoutePreference = {
  provider: AiProvider;
  openAiModel: OpenAiModelPreference;
};
