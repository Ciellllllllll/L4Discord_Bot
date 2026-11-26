import type { CancelPendingModmailReplies } from "../features/appeals/appealHandlers.js";
import { cancelPendingRepliesByAppeal } from "../features/modmail/modmailStaffFlow.js";

// appeals は modmail を直接 import しない。BotContext を組み立てる index.ts が
// この束縛を cancelPendingModmailReplies に入れる。
export const botCancelPendingModmailReplies: CancelPendingModmailReplies = cancelPendingRepliesByAppeal;
