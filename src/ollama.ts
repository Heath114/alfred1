// The model runs locally in Ollama (https://ollama.com), so commands and messages never leave the Mac.

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type Chat = (messages: ChatMessage[], tools: ToolSpec[]) => Promise<ChatMessage>;

// Ollama's default context window is small (2048-4096 tokens depending on version) and it silently
// drops the start of anything longer: the instructions and tool list go first, and the model then
// behaves as if it never had them. Alfred's prompt + tools + a few rounds need about 4-6k.
const CONTEXT = 12288;

export function ollama(model: string, host = "http://127.0.0.1:11434", contextLength = CONTEXT): Chat {
  return async (messages, tools) => {
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: false,
        think: false, // reasoning models are much slower with it on; commands are short
        keep_alive: "60m", // stay loaded between commands
        options: { temperature: 0, num_ctx: contextLength },
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { message?: ChatMessage };
    if (!data.message) throw new Error("Ollama returned no message");
    return data.message;
  };
}

// Any local server with an OpenAI-style /v1/chat/completions: LM Studio (MLX, often the fastest on
// Apple Silicon), llama.cpp's llama-server, mlx_lm.server. Still local; nothing leaves the Mac.
export function openaiCompatible(model: string, baseUrl: string): Chat {
  return async (messages, tools) => {
    // That API pairs each tool result with its call by id; ours are in order, so number them.
    let pending: string[] = [];
    const wire = messages.map((m, i) => {
      if (m.role === "assistant" && m.tool_calls?.length) {
        pending = m.tool_calls.map((_, j) => `call_${i}_${j}`);
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.tool_calls.map((c, j) => ({
            id: pending[j],
            type: "function",
            function: {
              name: c.function.name,
              arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments),
            },
          })),
        };
      }
      if (m.role === "tool") return { role: "tool", tool_call_id: pending.shift() ?? `call_${i}`, content: m.content };
      return { role: m.role, content: m.content };
    });
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: wire, tools, temperature: 0, stream: false }),
    });
    if (!res.ok) throw new Error(`Model server ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices?: { message: { content?: string | null; tool_calls?: { function: { name: string; arguments: string } }[] } }[];
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("Model server returned no message");
    return {
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: msg.tool_calls?.map((c) => ({ function: { name: c.function.name, arguments: c.function.arguments } })),
    };
  };
}

// For the status check: is the model server up, and does it have the model?
export async function modelAvailable(model: string, openaiUrl?: string, ollamaHost = "http://127.0.0.1:11434"): Promise<void> {
  const url = openaiUrl ? `${openaiUrl.replace(/\/$/, "")}/models` : `${ollamaHost}/api/tags`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    throw new Error(openaiUrl ? `No model server at ${openaiUrl}.` : "Ollama isn't running.");
  }
  const data = (await res.json()) as { models?: { name: string }[]; data?: { id: string }[] };
  const names = openaiUrl ? (data.data ?? []).map((m) => m.id) : (data.models ?? []).map((m) => m.name);
  const wanted = (name: string) => name === model || name === `${model}:latest` || name.startsWith(`${model}@`);
  if (!names.some(wanted)) {
    throw new Error(openaiUrl ? `Model "${model}" isn't loaded.` : `Model "${model}" isn't downloaded (ollama pull ${model}).`);
  }
}
