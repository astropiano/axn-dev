import type { FlowAdapter, FlowAdapterContext, FlowAdapterStep } from "@axn-dev/core";

/**
 * Generic HTTP message adapter — POSTs the step's message to the prepared
 * scenario's base URL.
 *
 *   <scenario name="demo" adapter="http" service="api"/>
 *   <usermessage>Hello</usermessage>
 *
 * Step attributes:
 *   path      URL path appended to baseUrl (default "/chat")
 *   field     JSON response field returned as the step output
 *             (default: tries response, message, text; else raw body)
 *
 * The request body is `{ "message", "provider", "model" }` — the model comes
 * from the flow's <models> selection.
 */
export const adapter: FlowAdapter = {
  async run(step: FlowAdapterStep, ctx: FlowAdapterContext): Promise<string> {
    if (!ctx.baseUrl) {
      throw new Error("http adapter requires a scenario base URL (wantsScenario)");
    }
    const model = ctx.model ?? { provider: "custom", name: "default" };
    const path = step.args?.path ?? "/chat";
    const url = `${ctx.baseUrl.replace(/\/$/, "")}${path}`;

    ctx.log(`POST ${url} with model ${model.provider}/${model.name}`);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: step.value ?? "", provider: model.provider, model: model.name }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const text = await response.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const field = step.args?.field;
      const picked =
        (field ? json[field] : undefined) ?? json.response ?? json.message ?? json.text;
      return typeof picked === "string" ? picked : text;
    } catch {
      return text;
    }
  },
};

export default adapter;
