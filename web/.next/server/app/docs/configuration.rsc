1:"$Sreact.fragment"
2:I[5521,[],""]
3:I[1237,[],""]
5:I[820,[],"OutletBoundary"]
7:I[4477,[],"AsyncMetadataOutlet"]
9:I[820,[],"ViewportBoundary"]
b:I[820,[],"MetadataBoundary"]
c:"$Sreact.suspense"
e:I[9795,[],""]
:HL["/_next/static/css/16b86866c6d3fdcc.css","style"]
0:{"P":null,"b":"R2U5frxuXf0JyspPZSVvK","p":"","c":["","docs","configuration"],"i":false,"f":[[["",{"children":["docs",{"children":[["slug","configuration","d"],{"children":["__PAGE__",{}]}]}]},"$undefined","$undefined",true],["",["$","$1","c",{"children":[[["$","link","0",{"rel":"stylesheet","href":"/_next/static/css/16b86866c6d3fdcc.css","precedence":"next","crossOrigin":"$undefined","nonce":"$undefined"}]],["$","html",null,{"lang":"en","children":["$","body",null,{"children":[["$","nav",null,{"className":"site-nav","children":[["$","a",null,{"href":"/","className":"nav-brand","children":"eforge"}],["$","ul",null,{"className":"nav-links","children":[["$","li",null,{"children":["$","a",null,{"href":"/docs","children":"Docs"}]}],["$","li",null,{"children":["$","a",null,{"href":"/reference","children":"Reference"}]}],["$","li",null,{"children":["$","a",null,{"href":"https://github.com/eforge-build/eforge","target":"_blank","rel":"noopener noreferrer","children":"GitHub"}]}],["$","li",null,{"children":["$","a",null,{"href":"https://www.npmjs.com/package/@eforge-build/eforge","target":"_blank","rel":"noopener noreferrer","children":"npm"}]}]]}]]}],["$","$L2",null,{"parallelRouterKey":"children","error":"$undefined","errorStyles":"$undefined","errorScripts":"$undefined","template":["$","$L3",null,{}],"templateStyles":"$undefined","templateScripts":"$undefined","notFound":[[["$","title",null,{"children":"404: This page could not be found."}],["$","div",null,{"style":{"fontFamily":"system-ui,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif,\"Apple Color Emoji\",\"Segoe UI Emoji\"","height":"100vh","textAlign":"center","display":"flex","flexDirection":"column","alignItems":"center","justifyContent":"center"},"children":["$","div",null,{"children":[["$","style",null,{"dangerouslySetInnerHTML":{"__html":"body{color:#000;background:#fff;margin:0}.next-error-h1{border-right:1px solid rgba(0,0,0,.3)}@media (prefers-color-scheme:dark){body{color:#fff;background:#000}.next-error-h1{border-right:1px solid rgba(255,255,255,.3)}}"}}],["$","h1",null,{"className":"next-error-h1","style":{"display":"inline-block","margin":"0 20px 0 0","padding":"0 23px 0 0","fontSize":24,"fontWeight":500,"verticalAlign":"top","lineHeight":"49px"},"children":404}],["$","div",null,{"style":{"display":"inline-block"},"children":["$","h2",null,{"style":{"fontSize":14,"fontWeight":400,"lineHeight":"49px","margin":0},"children":"This page could not be found."}]}]]}]}]],[]],"forbidden":"$undefined","unauthorized":"$undefined"}]]}]}]]}],{"children":["docs",["$","$1","c",{"children":[null,["$","div",null,{"style":{"display":"flex","maxWidth":"var(--max-width)","margin":"0 auto","padding":"var(--spacing-xl)","gap":"var(--spacing-2xl)"},"children":[["$","aside",null,{"style":{"width":"220px","flexShrink":0,"position":"sticky","top":"60px","alignSelf":"flex-start","height":"calc(100vh - 60px)","overflowY":"auto"},"children":["$","nav",null,{"children":[["$","div","Guides",{"style":{"marginBottom":"var(--spacing-lg)"},"children":[["$","div",null,{"style":{"fontSize":"0.75rem","fontWeight":700,"textTransform":"uppercase","letterSpacing":"0.05em","color":"var(--color-text-muted)","marginBottom":"var(--spacing-sm)"},"children":"Guides"}],["$","ul",null,{"style":{"listStyle":"none","padding":0,"margin":0},"children":[["$","li","getting-started",{"style":{"marginBottom":"0.25rem"},"children":["$","a",null,{"href":"/docs/getting-started","style":{"fontSize":"0.9rem","color":"var(--color-text)","display":"block","padding":"0.2rem 0"},"children":"Getting Started"}]}],["$","li","concepts",{"style":{"marginBottom":"0.25rem"},"children":["$","a",null,{"href":"/docs/concepts","style":{"fontSize":"0.9rem","color":"var(--color-text)","display":"block","padding":"0.2rem 0"},"children":"Core Concepts"}]}],["$","li","configuration",{"style":{"marginBottom":"0.25rem"},"children":["$","a",null,{"href":"/docs/configuration","style":{"fontSize":"0.9rem","color":"var(--color-text)","display":"block","padding":"0.2rem 0"},"children":"Configuration"}]}]]}]]}]]}]}],["$","main",null,{"style":{"flex":1,"minWidth":0},"children":["$","$L2",null,{"parallelRouterKey":"children","error":"$undefined","errorStyles":"$undefined","errorScripts":"$undefined","template":["$","$L3",null,{}],"templateStyles":"$undefined","templateScripts":"$undefined","notFound":"$undefined","forbidden":"$undefined","unauthorized":"$undefined"}]}]]}]]}],{"children":[["slug","configuration","d"],["$","$1","c",{"children":[null,["$","$L2",null,{"parallelRouterKey":"children","error":"$undefined","errorStyles":"$undefined","errorScripts":"$undefined","template":["$","$L3",null,{}],"templateStyles":"$undefined","templateScripts":"$undefined","notFound":"$undefined","forbidden":"$undefined","unauthorized":"$undefined"}]]}],{"children":["__PAGE__",["$","$1","c",{"children":["$L4",null,["$","$L5",null,{"children":["$L6",["$","$L7",null,{"promise":"$@8"}]]}]]}],{},null,false]},null,false]},null,false]},null,false],["$","$1","h",{"children":[null,[["$","$L9",null,{"children":"$La"}],null],["$","$Lb",null,{"children":["$","div",null,{"hidden":true,"children":["$","$c",null,{"fallback":null,"children":"$Ld"}]}]}]]}],false]],"m":"$undefined","G":["$e",[]],"s":false,"S":true}
f:T1968,<h1>Configuration</h1>
<p>eforge is configured via <code>eforge/config.yaml</code> (searched upward from cwd). All fields are optional - defaults work for most projects. This page covers the most commonly tuned options. For the full schema see the <a href="/reference/config">Configuration Reference</a>.</p>
<h2>The Three Config Tiers</h2>
<p>Config merges from three levels (lowest to highest priority):</p>
<table>
<thead>
<tr>
<th>Tier</th>
<th>Path</th>
<th>Committed?</th>
<th>Purpose</th>
</tr>
</thead>
<tbody>
<tr>
<td>User</td>
<td><code>~/.config/eforge/config.yaml</code></td>
<td>No</td>
<td>Cross-project, personal</td>
</tr>
<tr>
<td>Project</td>
<td><code>eforge/config.yaml</code></td>
<td>Yes</td>
<td>Team-canonical</td>
</tr>
<tr>
<td>Project-local</td>
<td><code>.eforge/config.yaml</code></td>
<td>No (gitignored)</td>
<td>Personal override</td>
</tr>
</tbody>
</table>
<p>The project-local tier deep-merges over the others. Use it for personal tuning - different model choices, extra verbosity, or test commands you do not want to commit.</p>
<h2>Initialization</h2>
<p>The fastest way to set up config is <code>/eforge:init</code> in Claude Code or Pi. It scaffolds <code>eforge/config.yaml</code> with sensible defaults and walks you through harness and model selection.</p>
<p>To edit config interactively after initialization: <code>/eforge:config --edit</code>.</p>
<h2>Agent Tiers</h2>
<p>Tiers are the primary configuration axis. Each tier is a self-contained recipe: <code>harness + model + effort</code>.</p>
<pre><code class="language-yaml">agents:
  tiers:
    planning:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
    implementation:
      harness: claude-sdk
      model: claude-sonnet-4-6
      effort: medium
    review:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
    evaluation:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
</code></pre>
<p>You only need to list tiers you want to change - unspecified tiers keep their engine defaults.</p>
<p><strong>Effort levels</strong>: <code>low</code>, <code>medium</code>, <code>high</code>, <code>xhigh</code>, <code>max</code>. Higher effort means more agent turns and more thorough output, at higher cost.</p>
<p><strong>Thinking</strong>: Add <code>thinking: true</code> to a tier to enable extended thinking. It is coerced to adaptive mode for models that only support adaptive thinking.</p>
<h2>Using the Pi Harness</h2>
<p>To build with a provider other than Anthropic, set <code>harness: pi</code> and add a <code>pi.provider</code> block:</p>
<pre><code class="language-yaml">agents:
  tiers:
    planning:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
    implementation:
      harness: pi
      model: anthropic/claude-sonnet-4-6
      effort: medium
      pi:
        provider: openrouter
</code></pre>
<p>Pi supports OpenAI, Google, Mistral, Groq, xAI, Bedrock, Azure, OpenRouter, and local models. Authentication resolves from provider-specific environment variables or <code>~/.pi/agent/auth.json</code>. For OAuth providers (OpenAI Codex, GitHub Copilot), run <code>pi auth login &#x3C;provider></code> first.</p>
<h2>Agent Runtime Profiles</h2>
<p>A profile bundles tier recipes into a reusable named file. This lets you switch between configurations - such as "use Claude for review, local model for implementation" - without editing <code>eforge/config.yaml</code>.</p>
<p>Profiles live at three scopes:</p>
<ul>
<li><code>~/.config/eforge/profiles/</code> - User scope</li>
<li><code>eforge/profiles/</code> - Project scope (committed)</li>
<li><code>.eforge/profiles/</code> - Project-local scope (gitignored)</li>
</ul>
<p>The active profile is resolved highest-priority-first. Set one with:</p>
<pre><code>/eforge:profile use &#x3C;name>
</code></pre>
<p>Or from the CLI: <code>eforge profile use &#x3C;name></code>.</p>
<h2>Post-Merge Commands</h2>
<p>Commands to run after all plans merge - compile, test, lint, or any validation step:</p>
<pre><code class="language-yaml">build:
  postMergeCommands:
    - "pnpm type-check"
    - "pnpm test"
  maxValidationRetries: 2
</code></pre>
<p>Each command runs under a 5-minute wall-clock timeout. On failure, a validation-fixer agent attempts repairs up to <code>maxValidationRetries</code> times.</p>
<h2>Queue Concurrency</h2>
<p>How many PRDs to build concurrently when processing the queue:</p>
<pre><code class="language-yaml">maxConcurrentBuilds: 2   # default
</code></pre>
<p>Within a single build, plans run in parallel automatically as their dependencies are satisfied - no configuration needed there.</p>
<h2>Per-Role Tuning</h2>
<p>Fine-tune individual agent roles without reassigning them to a different tier:</p>
<pre><code class="language-yaml">agents:
  roles:
    builder:
      effort: high
      maxTurns: 80
    reviewer:
      promptAppend: |
        ## Project Rules
        - Flag raw SQL queries
        - Require error handling for all async operations
    formatter:
      effort: low
</code></pre>
<p>Available per-role fields: <code>tier</code>, <code>effort</code>, <code>thinking</code>, <code>maxTurns</code>, <code>allowedTools</code>, <code>disallowedTools</code>, <code>promptAppend</code>, <code>shards</code> (builder-only).</p>
<h2>Custom Prompts</h2>
<p>Override any bundled agent prompt by placing a <code>.md</code> file in <code>eforge/prompts/</code> with the same name as the role:</p>
<pre><code class="language-yaml">agents:
  promptDir: eforge/prompts
</code></pre>
<p>If <code>eforge/prompts/reviewer.md</code> exists, it replaces the bundled reviewer prompt entirely. Use <code>promptAppend</code> on a role for additive rules instead of full replacement.</p>
<h2>Hooks</h2>
<p>Hooks are fire-and-forget shell commands triggered by eforge events - useful for notifications, logging, and external integrations:</p>
<pre><code class="language-yaml">hooks:
  - event: build:complete
    run: "notify-send 'Build complete'"
  - event: build:failed
    run: "curl -X POST $SLACK_WEBHOOK -d '{\"text\": \"Build failed\"}'"
</code></pre>
<p>Hooks do not block the pipeline. See the <a href="/reference/config#hooks">hooks reference</a> for the full event list.</p>
<h2>Full Reference</h2>
<p>For the complete <code>eforge/config.yaml</code> schema with all fields, types, and defaults, see the <a href="/reference/config">Configuration Reference</a>.</p>
4:["$","article",null,{"className":"prose","children":[["$","h1",null,{"children":"Configuration"}],["$","div",null,{"dangerouslySetInnerHTML":{"__html":"$f"}}]]}]
a:[["$","meta","0",{"charSet":"utf-8"}],["$","meta","1",{"name":"viewport","content":"width=device-width, initial-scale=1"}]]
6:null
8:{"metadata":[["$","title","0",{"children":"Configuration - eforge Docs"}],["$","meta","1",{"name":"description","content":"eforge is an autonomous plan-build-review orchestration engine for agentic code generation."}]],"error":null,"digest":"$undefined"}
d:"$8:metadata"
