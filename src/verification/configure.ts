import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliName } from "../types.js";

/** Disposable model settings adapted from merged cledger native drivers (MIT).
 * Returned flags apply only to synthetic verification repos, never user launches.
 */
export async function configureScriptedTarget(cli: CliName, root: string, repo: string, endpoint: string): Promise<string[]> {
  const env = process.env;
  const json = async (path: string, content: unknown) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(content), { mode: 0o600 }); };
  const text = async (path: string, content: string) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, content, { mode: 0o600 }); };
  if (cli === "claude-code") {
    const home = join(root, ".claude");
    Object.assign(env, { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "FAKE_TESTONLY_LOCAL", ANTHROPIC_BASE_URL: endpoint,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1" });
    await json(join(home, ".claude.json"), { hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: { approved: ["FAKE_TESTONLY_LOCAL"], rejected: [] }, projects: { [repo]: { hasTrustDialogAccepted: true } } });
    return ["--settings", join(home, "settings.json"), "--debug-file", join(root, "claude-debug.log"), "--model", "claude-sonnet-4-6", "--tools", "Read", "--allowedTools", "Read", "--strict-mcp-config"];
  }
  if (cli === "codex" || cli === "open-interpreter") {
    const home = join(root, cli === "codex" ? ".codex" : ".interpreter");
    env[cli === "codex" ? "CODEX_HOME" : "INTERPRETER_HOME"] = home;
    await text(join(home, "config.toml"), [cli === "codex" ? 'model = "gpt-5.4"' : 'model = "ledger-test"', 'model_provider = "verification"', 'approval_policy = "never"', 'check_for_update_on_startup = false',
      '[model_providers.verification]', 'name = "TESTONLY fixture"', `base_url = ${JSON.stringify(endpoint + "/v1")}`, 'wire_api = "responses"', 'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0',
      `[projects.${JSON.stringify(repo)}]`, 'trust_level = "trusted"'].join("\n"));
    return ["--dangerously-bypass-hook-trust", "--sandbox", "read-only", "--no-alt-screen"];
  }
  if (cli === "opencode" || cli === "kilo") {
    const home = join(root, "config", cli);
    Object.assign(env, { OPENCODE_DISABLE_FFF: "1", KILO_DISABLE_AUTOUPDATE: "true", KILO_DISABLE_MODELS_FETCH: "true", KILO_DISABLE_DEFAULT_PLUGINS: "true", KILO_DISABLE_EXTERNAL_SKILLS: "true", KILO_DISABLE_LSP_DOWNLOAD: "true" });
    await json(join(home, "tui.json"), { theme: "opencode", keybinds: { tool_details: "ctrl+o", session_toggle_generic_tool_output: "ctrl+y", session_first: "ctrl+g" } });
    await json(join(home, cli + ".json"), { enabled_providers: ["verification"], model: "verification/fixture", small_model: "verification/fixture", share: "disabled",
      permission: { "*": "deny", read: "allow", external_directory: { [join(root, ".turnbridge", "bootstrap", "*")]: "allow" } }, provider: { verification: { npm: "@ai-sdk/openai-compatible", options: { baseURL: endpoint + "/v1", apiKey: "TESTONLY-fixture" },
        models: { fixture: { name: "fixture", limit: { context: 65536, output: 2048 } } } } } });
    return [];
  }
  if (cli === "qwen-code") {
    env.QWEN_RUNTIME_DIR = join(root, ".qwen");
    Object.assign(env, { OPENAI_API_KEY: "TESTONLY-fixture", OPENAI_BASE_URL: endpoint + "/v1", OPENAI_MODEL: "fixture" });
    await json(join(root, ".qwen", "settings.json"), { security: { auth: { selectedType: "openai" } }, model: { name: "fixture" }, modelProviders: { openai: [{ id: "fixture", baseUrl: endpoint + "/v1", envKey: "OPENAI_API_KEY" }] }, telemetry: { enabled: false } });
    return ["--approval-mode", "yolo"];
  }
  if (cli === "gemini-cli") {
    Object.assign(env, { GEMINI_API_KEY: "TESTONLY-fixture", GOOGLE_GEMINI_BASE_URL: endpoint, GEMINI_CLI_HOME: root, GEMINI_CLI_TRUST_WORKSPACE: "true" });
    await json(join(root, ".gemini", "settings.json"), { general: { enableAutoUpdate: false, enableAutoUpdateNotification: false }, security: { auth: { selectedType: "gemini-api-key" } }, telemetry: { enabled: false }, model: { name: "gemini-2.5-flash" } });
    return ["--approval-mode", "auto_edit"];
  }
  if (cli === "pi") {
    const home = join(root, ".pi", "agent"); env.PI_CODING_AGENT_DIR = home;
    await json(join(home, "models.json"), { providers: { verification: { baseUrl: endpoint + "/v1", api: "openai-completions", apiKey: "TESTONLY-local",
      models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
    await json(join(home, "settings.json"), { defaultProvider: "verification", defaultModel: "fixture", retry: { enabled: false }, quietStartup: true });
    return ["--offline", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--tools", "read", "--thinking", "off", "--provider", "verification", "--model", "fixture"];
  }
  if (cli === "copilot") {
    Object.assign(env, { COPILOT_HOME: join(root, ".copilot"), COPILOT_PROVIDER_API_KEY: "TESTONLY-local", COPILOT_PROVIDER_BASE_URL: endpoint + "/v1", COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_WIRE_API: "completions", COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "2048", COPILOT_MODEL: "fixture" });
    await json(join(root, ".copilot", "config.json"), { trustedFolders: [repo] });
    return ["--allow-tool", "view", "--disable-builtin-mcps", "--no-auto-update", "--no-custom-instructions", "--no-ask-user", "--no-remote-export"];
  }
  if (cli === "kimi") {
    Object.assign(env, { KIMI_CODE_HOME: join(root, ".kimi-code"), KIMI_DISABLE_TELEMETRY: "1", KIMI_DISABLE_CRON: "1", KIMI_CODE_BUILTIN_PRODUCT_SKILLS: "0" });
    await text(join(root, ".kimi-code", "config.toml"), `default_model = "fixture"\ntelemetry = false\n[providers.verification]\ntype = "openai"\nbase_url = ${JSON.stringify(endpoint + "/v1")}\napi_key = "TESTONLY-fixture"\n[models.fixture]\nprovider = "verification"\nmodel = "fixture"\nmax_context_size = 65536\ncapabilities = ["tool_use"]\n[loop_control]\nmax_steps_per_turn = 6\nmax_attempts_per_step = 1\n`);
    return ["--model", "fixture", "--auto"];
  }
  if (cli === "goose") {
    Object.assign(env, { GOOSE_PATH_ROOT: join(root, ".config", "goose"), GOOSE_DISABLE_KEYRING: "1", GOOSE_DISABLE_SESSION_NAMING: "true", GOOSE_TELEMETRY_ENABLED: "false", GOOSE_MODE: "auto", OPENAI_API_KEY: "TESTONLY-local", OPENAI_BASE_URL: endpoint + "/v1" });
    return ["--no-profile", "--with-builtin", "developer", "--provider", "openai", "--model", "gpt-4o"];
  }
  if (cli === "continue") {
    const home = join(root, ".continue"); env.CONTINUE_GLOBAL_DIR = home; env.DO_NOT_TRACK = "1";
    await text(join(home, "config.yaml"), `name: Verification\nversion: 1.0.0\nschema: v1\nmodels:\n  - name: fixture\n    provider: openai\n    model: gpt-4o\n    apiBase: ${endpoint}/v1\n    apiKey: TESTONLY-local\n    roles: [chat]\n`);
    return ["--config", join(home, "config.yaml"), "--allow", "Read"];
  }
  if (cli === "openhands") {
    Object.assign(env, { OPENHANDS_PERSISTENCE_DIR: join(root, ".openhands"), OPENHANDS_CONVERSATIONS_DIR: join(root, ".openhands", "conversations"),
      LLM_API_KEY: "TESTONLY-local", LLM_BASE_URL: endpoint + "/v1", LLM_MODEL: "openai/gpt-4o", LITELLM_LOCAL_MODEL_COST_MAP: "True", OPENHANDS_SUPPRESS_BANNER: "1", DO_NOT_TRACK: "1" });
    return ["--always-approve", "--override-with-envs", "--exit-without-confirmation"];
  }
  if (cli === "mistral-vibe") {
    env.VIBE_HOME = join(root, ".vibe"); env.VIBE_VERIFICATION_KEY = "TESTONLY-fixture";
    await text(join(root, ".vibe", "config.toml"), `active_model = "fixture"\nenable_telemetry = false\nenable_update_checks = false\nenable_auto_update = false\n[[providers]]\nname = "verification"\napi_base = ${JSON.stringify(endpoint + "/v1")}\napi_key_env_var = "VIBE_VERIFICATION_KEY"\napi_style = "openai"\n[[models]]\nname = "fixture"\nprovider = "verification"\nalias = "fixture"\n[session_logging]\nenabled = true\ngenerate_titles = false\n`);
    return ["--trust", "--auto-approve", "--enabled-tools", "read_file"];
  }
  if (cli === "droid") {
    await json(join(root, ".factory", "settings.json"), { cloudSessionSync: false, model: "custom:Verification-0", customModels: [{ model: "fixture", displayName: "Verification", baseUrl: endpoint + "/v1", apiKey: "TESTONLY-local", provider: "generic-chat-completion-api", maxOutputTokens: 2048 }] });
    return ["--disable-builtin-skills"];
  }
  if (cli === "crush") {
    await json(join(repo, "crush.json"), { providers: { verification: { id: "verification", name: "Verification", type: "openai-compat", base_url: endpoint + "/v1", api_key: "TESTONLY-local",
      models: [{ id: "fixture", name: "Fixture", context_window: 65536, default_max_tokens: 2048, can_reason: false, supports_attachments: false, cost_per_1m_in: 0, cost_per_1m_out: 0, cost_per_1m_in_cached: 0, cost_per_1m_out_cached: 0 }] } },
      models: { large: { provider: "verification", model: "fixture" }, small: { provider: "verification", model: "fixture" } }, permissions: { allowed_tools: ["view"] }, options: { disable_provider_auto_update: true, disable_default_providers: true, disable_metrics: true } });
    return ["--data-dir", join(repo, ".crush")];
  }
  if (cli === "aider") {
    Object.assign(env, { OPENAI_API_BASE: endpoint + "/v1", OPENAI_API_KEY: "TESTONLY-local", LITELLM_LOCAL_MODEL_COST_MAP: "True" });
    return ["--edit-format", "whole", "--no-stream", "--yes", "--no-pretty", "--no-fancy-input", "--model", "openai/fixture", "--weak-model", "openai/fixture", "--no-check-update", "--no-show-release-notes", "--no-show-model-warnings", "--no-analytics", "--no-auto-commits", "--no-dirty-commits", "--no-gitignore", "--no-detect-urls", "--no-auto-lint", "--no-auto-test", "--map-tokens", "0", "evidence.txt"];
  }
  return [];
}

export const TERMINAL_SYNTAX: Record<CliName, { ready: string; quit: string }> = {
  "claude-code": { ready: "← for agents|for shortcuts", quit: "/exit" }, codex: { ready: "Ask Codex to do anything", quit: "/exit" },
  opencode: { ready: "Ask anything|Ask a question|Build\\s*·\\s*fixture verification", quit: "/exit" }, kilo: { ready: "Ask anything|Ask a question|(?:Build|Code)\\s*·\\s*fixture verification", quit: "/exit" },
  "gemini-cli": { ready: "Ready \\(repo\\)", quit: "/quit" }, "qwen-code": { ready: "Type your message|Type a message|> ", quit: "/quit" },
  copilot: { ready: "tab next tab", quit: "/quit" }, cursor: { ready: "Ask|Type|❯", quit: "/quit" },
  kimi: { ready: "context:.*\\(|Type a message", quit: "/exit" }, "mistral-vibe": { ready: "> |Ask|Type", quit: "/exit" },
  droid: { ready: "Type|Ask|❯", quit: "/quit" }, kiro: { ready: "ask a question or describe a task", quit: "/quit" },
  pi: { ready: "─|fixture", quit: "/quit" }, openhands: { ready: "Type|Task|OpenHands", quit: "/exit" }, cline: { ready: "Type|Ask|❯", quit: "/exit" },
  "open-interpreter": { ready: "ledger-test default", quit: "/exit" }, goose: { ready: "Enter to send", quit: "/exit" },
  aider: { ready: "> ", quit: "/exit" }, continue: { ready: "Ask anything", quit: "/exit" }, crush: { ready: "Ready[!.?]|Ready for instructions", quit: "\x03y" },
};
