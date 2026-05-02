<script lang="ts">
  import type { AgentCallTrace, TokenLogprob } from '../types'
  import TokenRenderer from './TokenRenderer.svelte'
  import LogprobTooltip from './LogprobTooltip.svelte'

  let { trace }: { trace: AgentCallTrace } = $props()

  let showTools = $state(false)
  let showOptions = $state(false)
  let showMessages = $state(true)
  let showReasoning = $state(true)
  let expandedItems = $state<Set<number>>(new Set())
  let hoveredToken = $state<TokenLogprob | null>(null)
  let tooltipX = $state(0)
  let tooltipY = $state(0)

  function toggleItem(idx: number) {
    const next = new Set(expandedItems)
    if (next.has(idx)) next.delete(idx)
    else next.add(idx)
    expandedItems = next
  }

  function formatTokens(n: number | undefined | null): string {
    if (n == null) return '—'
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
    return String(n)
  }

  const roleColors: Record<string, string> = {
    system: 'var(--accent-yellow)',
    developer: 'var(--accent-yellow)',
    user: 'var(--accent-green)',
    assistant: 'var(--accent-blue)',
    tool: 'var(--accent-purple)',
  }

  const finishReasonColors: Record<string, string> = {
    stop: 'var(--accent-green)',
    end_turn: 'var(--accent-green)',
    tool_calls: 'var(--accent-blue)',
    length: 'var(--accent-red)',
    content_filter: 'var(--accent-red)',
  }

  const callTypeColors: Record<string, string> = {
    chat: 'var(--accent-blue)',
    compact: 'var(--accent-yellow)',
    autopilot: 'var(--accent-green)',
    title: 'var(--text-muted)',
    'extract-memory-diff': 'var(--accent-purple)',
  }

  function getMessageText(msg: any): string | null {
    if (typeof msg?.content === 'string') return msg.content
    if (Array.isArray(msg?.content)) {
      const parts = msg.content
        .map((p: any) => typeof p === 'string' ? p : p?.text ?? p?.output_text ?? null)
        .filter((p: string | null): p is string => typeof p === 'string' && p.length > 0)
      if (parts.length > 0) return parts.join('')
    }
    return null
  }

  function getMessagePreview(msg: any): string {
    const text = getMessageText(msg)
    if (text !== null) return text.slice(0, 120) + (text.length > 120 ? '...' : '')
    if (msg.tool_calls) return `${msg.tool_calls.length} tool call(s)`
    return JSON.stringify(msg.content).slice(0, 120)
  }

  function getMessageContent(msg: any): string {
    const text = getMessageText(msg)
    if (text !== null) return text
    return JSON.stringify(msg.content, null, 2)
  }
</script>

<div class="p-4 space-y-4">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      <span
        class="text-[10px] font-mono px-1.5 py-0.5 rounded"
        style="color: {callTypeColors[trace.callType] ?? 'var(--text-secondary)'}; border: 1px solid {callTypeColors[trace.callType] ?? 'var(--text-secondary)'}40"
      >
        {trace.callType}
      </span>
      <span class="font-mono text-sm text-[var(--text-secondary)]">{trace.modelId}</span>
      {#if trace.forkId}
        <span class="text-xs font-mono text-[var(--accent-purple)]">{trace.forkId.slice(0, 8)}</span>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      <span class="text-sm text-[var(--text-muted)]">{new Date(trace.startedAt).toLocaleString()}</span>
      <span class="text-sm text-[var(--text-secondary)]">{(trace.durationMs / 1000).toFixed(1)}s</span>
    </div>
  </div>

  <!-- Connection Error -->
  {#if trace.connectionError}
    <div class="p-3 rounded-lg bg-red-950/30 border border-red-800/50">
      <div class="flex items-center gap-2 mb-1">
        <span class="text-xs font-mono font-semibold text-red-400">{(trace.connectionError as any)._tag}</span>
        {#if (trace.connectionError as any).status}
          <span class="text-xs text-red-400/70">HTTP {(trace.connectionError as any).status}</span>
        {/if}
      </div>
      {#if (trace.connectionError as any).message}
        <pre class="text-xs font-mono text-red-300/80 whitespace-pre-wrap">{(trace.connectionError as any).message}</pre>
      {/if}
      {#if (trace.connectionError as any).retryAfterMs}
        <span class="text-xs text-red-400/60">Retry after: {(trace.connectionError as any).retryAfterMs}ms</span>
      {/if}
    </div>
  {/if}

  <!-- Usage -->
  {#if trace.response.usage}
    <div class="p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)]">
      <div class="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">Usage</div>
      <div class="grid grid-cols-4 gap-3 text-sm">
        <div>
          <div class="text-[var(--text-muted)] text-xs">Input</div>
          <div class="font-mono">{formatTokens(trace.response.usage.inputTokens)}</div>
        </div>
        <div>
          <div class="text-[var(--text-muted)] text-xs">Output</div>
          <div class="font-mono">{formatTokens(trace.response.usage.outputTokens)}</div>
        </div>
        <div>
          <div class="text-[var(--text-muted)] text-xs">Cache Read</div>
          <div class="font-mono">{formatTokens(trace.response.usage.cacheReadTokens)}</div>
        </div>
        <div>
          <div class="text-[var(--text-muted)] text-xs">Cache Write</div>
          <div class="font-mono">{formatTokens(trace.response.usage.cacheWriteTokens)}</div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Request Messages -->
  <div class="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)]">
    <button
      class="w-full text-left px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-[var(--bg-hover)] rounded-t-lg"
      onclick={() => showMessages = !showMessages}
    >
      <span class="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Request Messages ({trace.request.messages?.length ?? 0})
      </span>
      <span class="text-[var(--text-muted)]">{showMessages ? '▼' : '▶'}</span>
    </button>
    {#if showMessages}
      <div class="border-t border-[var(--border)]">
        {#each (trace.request.messages ?? []) as msg, idx}
          <div class="border-b border-[var(--border)]/50 last:border-b-0">
            <button
              class="w-full text-left px-3 py-2 flex items-start gap-2 cursor-pointer hover:bg-[var(--bg-hover)]"
              onclick={() => toggleItem(idx)}
            >
              <span
                class="text-xs font-mono font-semibold flex-shrink-0 mt-0.5"
                style="color: {roleColors[msg.role] || 'var(--text-secondary)'}"
              >
                {msg.role}
              </span>
              <span class="text-xs text-[var(--text-secondary)] truncate">
                {#if expandedItems.has(idx)}
                  ▼
                {:else}
                  {getMessagePreview(msg)}
                {/if}
              </span>
            </button>
            {#if expandedItems.has(idx)}
              <div class="px-3 pb-3 space-y-2">
                {#if (msg as any).reasoning_content}
                  <div class="text-xs text-[var(--text-muted)] italic">
                    <span class="font-semibold">Reasoning:</span>
                    <pre class="mt-1 font-mono whitespace-pre-wrap break-words overflow-x-auto max-h-96 overflow-y-auto">{(msg as any).reasoning_content}</pre>
                  </div>
                {/if}
                <pre class="text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words overflow-x-auto max-h-96 overflow-y-auto">{getMessageContent(msg)}</pre>
                {#if (msg as any).tool_calls}
                  <div class="space-y-1">
                    {#each (msg as any).tool_calls as tc}
                      <div class="p-2 rounded bg-[var(--bg-tertiary)] border border-[var(--border)]/50">
                        <div class="flex items-center gap-2 mb-1">
                          <span class="text-xs font-mono font-semibold text-[var(--accent-purple)]">{tc.function?.name ?? tc.name}</span>
                          <span class="text-xs text-[var(--text-muted)]">{tc.id}</span>
                        </div>
                        <pre class="text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap">{(() => { try { return JSON.stringify(JSON.parse(tc.function?.arguments ?? '{}'), null, 2) } catch { return tc.function?.arguments ?? '' } })()}</pre>
                      </div>
                    {/each}
                  </div>
                {/if}
                {#if msg.role === 'tool' && (msg as any).tool_call_id}
                  <div class="text-xs text-[var(--text-muted)]">tool_call_id: {(msg as any).tool_call_id}</div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Request Tools -->
  {#if trace.request.tools && trace.request.tools.length > 0}
    <div class="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)]">
      <button
        class="w-full text-left px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-[var(--bg-hover)] rounded-t-lg"
        onclick={() => showTools = !showTools}
      >
        <span class="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Request Tools ({trace.request.tools.length})
        </span>
        <span class="text-[var(--text-muted)]">{showTools ? '▼' : '▶'}</span>
      </button>
      {#if showTools}
        <div class="border-t border-[var(--border)]">
          {#each trace.request.tools as tool}
            <div class="border-b border-[var(--border)]/50 last:border-b-0 px-3 py-2">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-xs font-mono font-semibold text-[var(--accent-purple)]">{(tool as any).function?.name ?? 'unknown'}</span>
              </div>
              {#if (tool as any).function?.description}
                <div class="text-xs text-[var(--text-secondary)] mb-1">{(tool as any).function.description}</div>
              {/if}
              {#if (tool as any).function?.parameters}
                <pre class="text-xs font-mono text-[var(--text-muted)] whitespace-pre-wrap break-words">{JSON.stringify((tool as any).function.parameters, null, 2)}</pre>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Request Options -->
  {#if trace.request}
    {@const opts = [
      trace.request.temperature != null ? ['Temperature', trace.request.temperature] : null,
      (trace.request as any).top_p != null ? ['Top P', (trace.request as any).top_p] : null,
      trace.request.max_tokens != null ? ['Max Tokens', trace.request.max_tokens] : null,
      (trace.request as any).reasoning_effort != null ? ['Reasoning Effort', (trace.request as any).reasoning_effort] : null,
      trace.request.tool_choice != null ? ['Tool Choice', typeof trace.request.tool_choice === 'string' ? trace.request.tool_choice : JSON.stringify(trace.request.tool_choice)] : null,
      (trace.request as any).logprobs != null ? ['Logprobs', String((trace.request as any).logprobs)] : null,
      (trace.request as any).top_logprobs != null ? ['Top Logprobs', (trace.request as any).top_logprobs] : null,
    ].filter((o): o is [string, any] => o !== null)}
    {#if opts.length > 0}
      <div class="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)]">
        <button
          class="w-full text-left px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-[var(--bg-hover)] rounded-t-lg"
          onclick={() => showOptions = !showOptions}
        >
          <span class="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Request Options</span>
          <span class="text-[var(--text-muted)]">{showOptions ? '▼' : '▶'}</span>
        </button>
        {#if showOptions}
          <div class="border-t border-[var(--border)] p-3">
            <div class="grid grid-cols-2 gap-2 text-sm">
              {#each opts as [label, value]}
                <div>
                  <span class="text-[var(--text-muted)]">{label}</span>
                  <span class="ml-2 font-mono">{value}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  {/if}

  <!-- Response Reasoning -->
  {#if trace.response.reasoning}
    <div class="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)]">
      <button
        class="w-full text-left px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-[var(--bg-hover)] rounded-t-lg"
        onclick={() => showReasoning = !showReasoning}
      >
        <span class="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Response Reasoning</span>
        <span class="text-[var(--text-muted)]">{showReasoning ? '▼' : '▶'}</span>
      </button>
      {#if showReasoning}
        <div class="border-t border-[var(--border)] p-3">
          <pre class="text-xs font-mono text-[var(--text-muted)] italic whitespace-pre-wrap break-words overflow-x-auto max-h-[600px] overflow-y-auto">{trace.response.reasoning}</pre>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Response Text -->
  {#if trace.response.text}
    <div class="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)]">
      <div class="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] px-3 py-2">Response Text</div>
      <div class="border-t border-[var(--border)] p-3">
        {#if trace.response.logprobs && trace.response.logprobs.length > 0}
          <TokenRenderer
            tokens={trace.response.logprobs}
            onHover={(token, _idx, e) => {
              hoveredToken = token
              tooltipX = e.clientX + 12
              tooltipY = e.clientY + 12
            }}
            onLeave={() => hoveredToken = null}
          />
        {:else}
          <pre class="text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words overflow-x-auto max-h-[600px] overflow-y-auto">{trace.response.text}</pre>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Response Tool Calls -->
  {#if trace.response.toolCalls.length > 0}
    <div class="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)]">
      <div class="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] px-3 py-2">
        Response Tool Calls ({trace.response.toolCalls.length})
      </div>
      <div class="border-t border-[var(--border)]">
        {#each trace.response.toolCalls as tc}
          <div class="border-b border-[var(--border)]/50 last:border-b-0 px-3 py-2">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-mono font-semibold text-[var(--accent-purple)]">{tc.name}</span>
              <span class="text-xs text-[var(--text-muted)]">{tc.id}</span>
            </div>
            <pre class="text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words overflow-x-auto max-h-48 overflow-y-auto">{JSON.stringify(tc.arguments, null, 2)}</pre>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Finish Reason -->
  {#if trace.response.finishReason}
    <div class="flex items-center gap-2">
      <span class="text-xs text-[var(--text-muted)]">Finish:</span>
      <span
        class="text-xs font-mono px-1.5 py-0.5 rounded"
        style="color: {finishReasonColors[trace.response.finishReason] ?? 'var(--text-muted)'}; border: 1px solid {finishReasonColors[trace.response.finishReason] ?? 'var(--text-muted)'}40"
      >
        {trace.response.finishReason}
      </span>
    </div>
  {/if}
</div>

{#if hoveredToken}
  <LogprobTooltip token={hoveredToken} x={tooltipX} y={tooltipY}/>
{/if}
