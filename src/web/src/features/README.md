# Feature mount points

The shell (`src/web/src/app`) renders each feature from a fixed module, so
features can be built independently:

| Module | Export | Shown where |
| --- | --- | --- |
| `features/chat/ChatView.tsx` | `ChatView({ spaceId })` | The space's Chat view (timeline + composer) |
| `features/viewer/FileViewer.tsx` | `FileViewer({ spaceId, path, onClose })` | Opening a file from a reply, a course, a plan |
| `features/study/StudyView.tsx` | `StudyView({ spaceId })` | Study view (education spaces) |
| `features/grades/GradesView.tsx` | `GradesView({ spaceId })` | Grades view (education spaces) |
| `features/plan/PlanView.tsx` | `PlanView({ spaceId })` | Plan view (education spaces) |
| `features/courses/CoursesView.tsx` | `CoursesView({ spaceId })` | Courses view (import, access, content) |
| `features/settings/AssistantSettings.tsx` | `AssistantSettings({ spaceId? })` | Settings → Assistant (providers, keys, models, backend) |
| `features/settings/AgentsSettings.tsx` | `AgentsSettings({ spaceId? })` | Settings → Coding agents (Claude Code, Codex, Gemini CLI) |

Navigation between them goes through `useNav()` from `@/app/nav` (owned by the shell).
