# Jev skill routing

Step Code can use [TypeSafe Jev](https://typesafe.ai/) to suggest an installed skill before the coding model starts a request. This is optional and disabled by default. It is intended to reduce missed or unnecessary skill loads when several skills are available.

## Enable

Install at least two [skills](skills.md), obtain a TypeSafe API key, and start Step Code with:

```bash
export TYPESAFE_API_KEY="<your-typesafe-api-key>"
export STEP_JEV_SKILL_ROUTING=1
step
```

For a single prompt:

```bash
STEP_JEV_SKILL_ROUTING=1 TYPESAFE_API_KEY="<your-typesafe-api-key>" \
  step -p "Use a browser to check the checkout page"
```

Use `pnpm step` in place of `step` when running from source. `JEV_API_KEY` is accepted as a fallback when `TYPESAFE_API_KEY` is empty. A key alone does not enable routing. Unset `STEP_JEV_SKILL_ROUTING` or set it to `0` before starting Step Code to disable it.

Jev uses a separate TypeSafe credential and billing account. Step sign-in and the coding model selected in `/model` continue to work as usual. This extension does not increase a Step Plan allowance.

## What happens

1. Before a new text request starts, Jev ranks the names and descriptions of the eligible skills and checks whether any skill is needed.
2. If there is a match, Step reads a short excerpt from each of up to three shortlisted skills. A second Jev call checks their suitability.
3. A sufficiently confident result adds a small suggestion to the current system prompt. The coding model decides whether to read and follow the suggested skill.

The full skill catalog stays available, including skills Jev did not select. Explicit skill requests and project instructions take precedence. The suggestion grants no tool permissions and does not execute a skill. It is reset before the next request and is not recomputed on every tool call within a request.

Both API calls and excerpt reads share a 1,500 ms deadline and honor task cancellation. Cancelling or closing the session while routing is pending stops further Jev calls and prevents the coding model from starting. There are no retries. A timeout, API error, malformed answer, uncertain result, or no match leaves the original prompt in place so the task can continue.

Routing is skipped for:

- `/skill:name` commands, expanded skill commands, and `$name` mentions of an installed skill.
- Requests with images, empty requests, or requests over 12,000 characters.
- Sessions without a `read` or `read_file` tool.
- Catalogs with fewer than two or more than 254 eligible skills, or duplicate names.

Skills with `disable-model-invocation: true` are excluded from automatic routing; explicit `/skill:name` commands still work. Existing discovery and project-trust rules determine which skills are available. `/reload` refreshes the catalog used for the next request.

## Data sent to TypeSafe

Enabling this feature sends data to `https://api.typesafe.ai/v1/systemone`, using the `jev-latest` model:

| Request | Data |
| --- | --- |
| Ranking | Current user request, eligible skill names and descriptions |
| Verification | Current user request, shortlisted names and descriptions, and up to 700 characters from each of at most three skill bodies |

The excerpt reader skips YAML frontmatter and reads at most the first 16 KiB of a skill file. A frontmatter block that extends beyond that prefix yields an empty excerpt. The extension does not separately attach local file paths, the system prompt, project context files, conversation history, tool results, images, or Step credentials. Text already present in the user request or skill metadata/body is sent as described above, so use this feature only for content you can share with TypeSafe.

The endpoint is fixed, and HTTP redirects are rejected. The extension does not persist routing requests or responses.

## Efficiency and measurement

The potential benefit is better skill selection: avoiding an irrelevant full skill read or finding a useful skill earlier. Keeping the complete catalog preserves its existing system-prompt prefix, but does not remove its tokens. The changing recommendation can affect caching after that prefix; it does not guarantee a cache hit for the rest of the conversation. Jev also adds API calls, billable input, and latency.

TypeSafe's [skill-suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion.md) reports an evaluation using 182 Hermes skills and 488 constructed requests. On 315 requests with a matching skill, the rate of a wrong or missing first skill load fell from 16.8% to 7.3%; on 173 requests without a match, unnecessary loads fell from 9.8% to 4.0%. Those results used Jev 1.12 and Claude Haiku 4.5. They are evidence from that experiment, not measured Step Code results. This integration uses its own conservative confidence gates and the `jev-latest` alias.

As of September 22, 2026, TypeSafe lists Jev 1.13.0 input at $0.042 per million tokens and output as free. Consult the current [models and pricing](https://docs.typesafe.ai/models.md) before enabling it.

To measure the effect on your workflow, compare the same tasks, skill catalog, coding model, and initial repository state with routing disabled and enabled. Include both matching and no-match tasks, and repeat runs to account for model variation. TypeSafe currently reports its best accuracy in English, so evaluate Chinese and other languages separately when they are part of your workflow. Record:

- Task completion quality and whether the first skill read was appropriate.
- Unnecessary skill reads and coding-model input, output, and cache usage.
- Jev charges and total cost per completed task.
- Time to the first coding-model response and total task latency, including slow or unavailable Jev calls.

Step's `/session` statistics cover the coding session; this extension's TypeSafe usage is not added to those totals. Include TypeSafe account usage separately when comparing costs. The automated tests exercise the real request format with a fake transport and a scripted coding model; they do not measure live Jev accuracy, production latency, token savings, or user growth.

See the [TypeSafe API reference](https://docs.typesafe.ai/api.md) for the typed Choice and Noul response formats.
