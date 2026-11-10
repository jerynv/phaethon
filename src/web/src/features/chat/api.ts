/**
 * The core commands the conversation uses, typed. Names, arguments and
 * results are the old Tauri ones (research/core-head.md §1).
 */
import type { AccessAnswer, AgentEvent, LessonAnswer, UiMessage } from "#shared/agent.ts";
import { Channel, invoke } from "@/lib/core";
import type { StudyPlan } from "./lib/study-chat";

export type Upload = { name: string; mediaType: string; data: string };

export const threadLoad = (space: string) => invoke<UiMessage[]>("thread_load", { space });

export function agentSend(args: {
  space: string;
  prompt: string;
  attachments: Upload[];
  onEvent: Channel<AgentEvent>;
  replaceFrom?: number;
  keepAttachments?: string[];
  continueFrom?: number;
}) {
  return invoke<void>("agent_send", args);
}

export const agentCancel = (space: string) => invoke<boolean>("agent_cancel", { space });
export const agentApprove = (space: string, id: string, allow: boolean) => invoke<boolean>("agent_approve", { space, id, allow });
export const agentAccessAnswer = (space: string, id: string, answer: AccessAnswer) =>
  invoke<boolean>("agent_access_answer", { space, id, answer });

/**
 * The student's answer to a lesson question. The core continues the lesson
 * with it and streams the rest of the turn on `onEvent`, ending with `end`.
 */
export const lessonAnswer = (space: string, id: string, answer: LessonAnswer, onEvent: Channel<AgentEvent>) =>
  invoke<boolean>("lesson_answer", { space, id, answer, onEvent });

export type Backend = "phaethon" | "claude-cli" | "codex-cli" | "gemini-cli";

export type ProviderView = {
  id: string;
  name: string;
  key: "required" | "optional" | "none";
  local: boolean;
  hasKey: boolean;
  model?: string | null;
  ready: boolean;
};

export type SettingsView = {
  backend: Backend;
  model: string | null;
  provider: string;
  defaultModel?: string | null;
  providerReady: boolean;
  providers: ProviderView[];
};

export type ModelInfo = { id: string; name: string; sees?: "yes" | "no" | "unknown" };

export type SpaceView = { id: string; name: string; description: string; hue: number; educationEnabled: boolean; lastUsed: number | null };

export const settingsGet = () => invoke<SettingsView>("settings_get");
export const spacesList = () => invoke<SpaceView[]>("spaces_list");
export const spaceModelsList = () => invoke<Record<string, string>>("space_models_list");
export const spaceModelSet = (space: string, model: string | null) => invoke<void>("space_model_set", { space, model });
export const modelsList = (provider?: string) => invoke<ModelInfo[]>("models_list", provider ? { provider } : {});

export type TutorMode = "normal" | "quiz" | "explain" | "socratic" | "cram";
export const tutorModesList = () => invoke<Record<string, TutorMode>>("space_tutor_modes_list");
export const tutorModeSet = (space: string, mode: TutorMode) => invoke<void>("space_tutor_mode_set", { space, mode });

export const fileOpen = (space: string, path: string, reveal = false) => invoke<void>("file_open", { space, path, reveal });
export const spaceShow = (id: string) => invoke<void>("space_show", { id });
export type Added = { paths: string[]; files: number; skipped: number };
export const spaceAdd = (id: string, folder: boolean) => invoke<Added | null>("space_add", { id, folder });

export type StudyEvent =
  | { type: "progress"; step: string; done: number; total: number; kept?: number; dropped?: number }
  | { type: "done"; path?: string; cards?: number; questions?: number }
  | { type: "error"; message: string }
  | { type: "cancelled" }
  | { type: "needsScope"; course: string; courseName: string; exam: string };

export const studyChatPlan = (space: string, block: string, question: string) => invoke<StudyPlan>("study_chat_plan", { space, block, question });
export const studyChatMake = (space: string, block: string, question: string, reply: string, onEvent: Channel<StudyEvent>) =>
  invoke<void>("study_chat_make", { space, block, question, reply, onEvent });
export const studyChatCancel = (space: string, origin: string) => invoke<boolean>("study_chat_cancel", { space, origin });

export type CitationCheck = {
  found: boolean;
  path: string;
  name: string;
  at?: string;
  page?: number;
  before?: string;
  passage?: string;
  after?: string;
  why?: string;
};
export const studyCitationsCheck = (space: string, citations: { path: string; quote: string }[]) =>
  invoke<CitationCheck[]>("study_citations_check", { space, citations });
