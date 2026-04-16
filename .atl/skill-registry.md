# Skill Registry — videojuegoHistoria

Generated: 2026-04-16

## Project Context

- **Project**: videojuegoHistoria (IMPURO)
- **Stack**: Vanilla JavaScript (ES2020+), HTML5, CSS3 (custom properties)
- **Architecture**: Single-page app, state machine pattern, data-driven (JSON config)
- **Bundler**: None (no build step, direct browser loading)
- **Testing**: None detected
- **Conventions**: No project-level CLAUDE.md, AGENTS.md, or .cursorrules

## User Skills (auto-scanned)

| Skill | Trigger | Source |
|-------|---------|--------|
| frontend-design | Building web UI, components, pages, styling | user (~/.agents/skills/) |
| react-19 | Writing React components | user (~/.opencode/skills/) |
| react-native | Building mobile apps with React Native/Expo | user (~/.opencode/skills/) |
| nextjs-15 | Working with Next.js App Router | user (~/.opencode/skills/) |
| typescript | Writing TypeScript code | user (~/.opencode/skills/) |
| tailwind-4 | Styling with Tailwind CSS | user (~/.opencode/skills/) |
| zustand-5 | Managing React state with Zustand | user (~/.opencode/skills/) |
| zod-4 | Using Zod for validation | user (~/.opencode/skills/) |
| ai-sdk-5 | Building AI chat features | user (~/.opencode/skills/) |
| electron | Building desktop apps with Electron | user (~/.opencode/skills/) |
| angular-core | Creating Angular components, signals | user (~/.opencode/skills/) |
| angular-architecture | Structuring Angular projects | user (~/.opencode/skills/) |
| angular-forms | Working with Angular forms | user (~/.opencode/skills/) |
| angular-performance | Optimizing Angular performance | user (~/.opencode/skills/) |
| django-drf | Building REST APIs with Django | user (~/.opencode/skills/) |
| spring-boot-3 | Building Spring Boot 3 apps | user (~/.opencode/skills/) |
| java-21 | Writing Java 21 code | user (~/.opencode/skills/) |
| hexagonal-architecture-layers-java | Hexagonal architecture in Java | user (~/.opencode/skills/) |
| pytest | Writing Python tests | user (~/.opencode/skills/) |
| playwright | Writing E2E tests | user (~/.opencode/skills/) |
| github-pr | Creating PRs with conventional commits | user (~/.opencode/skills/) |
| jira-task | Creating Jira tasks | user (~/.opencode/skills/) |
| jira-epic | Creating Jira epics | user (~/.opencode/skills/) |
| elixir-antipatterns | Elixir/Phoenix anti-patterns | user (~/.opencode/skills/) |
| go-testing | Go testing patterns | user (~/.config/opencode/skills/) |
| skill-creator | Creating new AI agent skills | user (~/.opencode/skills/) |
| skill-registry | Update skill registry | user (~/.config/opencode/skills/) |
| judgment-day | Parallel adversarial review | user (~/.config/opencode/skills/) |
| issue-creation | GitHub issue creation | user (~/.config/opencode/skills/) |
| branch-pr | PR creation workflow | user (~/.config/opencode/skills/) |

## Compact Rules

### This Project (videojuegoHistoria)

- **Language**: Vanilla JS (ES2020+), no frameworks, no build step
- **UI**: Custom visual novel engine with state machine (intro/play/feedback/end)
- **Data**: JSON-driven scenes and questions in `src/data/game-config.json`
- **Styling**: CSS custom properties, dark theme, responsive (mobile accordion at 700px)
- **Audio**: AudioManager class, sounds disabled by default, toggled by user
- **Integration**: Dual runtime — standalone (index.html) and Twine/SugarCube (twine/)
- **Naming**: BEM-like with `impuro-` prefix for CSS, `data-ref` attributes for JS bindings
- **No package.json**: No npm, no bundler, no test framework
- **Docs**: Internal guides in `docs/` (motor guide, sounds spec)

### Relevant Skills for This Stack

- **frontend-design**: Relevant when styling/building UI components for the game
- **playwright**: Could be relevant if E2E testing is added in the future
