// AI ルータのタスク・フォールバック理由の型。
// aiProviderRouter.ts と aiRouterHelpers.ts の循環 import を避けるため、両方がここを参照する。

export type AiTask =
  | "answer"
  | "judge"
  | "prompt_optimizer"
  | "prompt_generator"
  | "senryu_review"
  | "pacchi_final_check"
  | "vx_translation"
  | "preview_translation"
  | "preview_summary"
  | "ping";

export type AiFallbackReason =
  | "manual_deepseek"
  | "task_policy_deepseek"
  | "openai_unconfigured"
  | "openrouter_unconfigured"
  | "openrouter_failed"
  | "openrouter_budget_threshold"
  | "usage_unavailable"
  | "budget_threshold"
  | "openai_unauthorized"
  | "openai_model_unavailable"
  | "openai_408"
  | "openai_429"
  | "openai_server_error"
  | "openai_network"
  | "openai_timeout"
  | "openai_invalid_response"
  | "openai_model_fallback";
