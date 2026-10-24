# Exomem development

- Develop and edit source locally in this repository. Use Git commits and push them to GitHub.
- The server only pulls committed code; never edit source on the server. Runtime configuration and secrets live outside the checkout.
- Never commit node_modules, generated builds, caches, databases, credentials, or personal memory.
- Write targeted tests for complex behavior (Unicode search, concurrent revisions, idempotency, import transactions). Do not add ceremonial CRUD tests or broad regression suites.
- Do not probe or attack the server to validate security. Use ordinary functional checks only.
- Use mature UI components and the complete Milkdown Crepe editor. Do not implement a Markdown editor.
- The entire WebUI, including errors and editor prompts, is in English. Memory content and search support all Unicode languages.
- Exomem has no curl, arbitrary network request, or shell tools. Every MCP memory operation takes a space token.
- Store precise event times in UTC and date-only events as calendar dates. Spaces have no timezone.
