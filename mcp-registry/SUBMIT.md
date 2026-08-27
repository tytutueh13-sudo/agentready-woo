# MCP Registry submission — AgentReady Woo

Submit to: https://registry.modelcontextprotocol.io (one publish -> PulseMCP, Smithery, Glama, mcp.directory ingest automatically)

## Prerequisites before submitting (in order)
1. Worker deployed + verified live — registry validates a LIVE url
2. Custom domain attached in wrangler.toml — done: app.utilityhouse.xyz (the
   /mcp path serves the MCP endpoint directly; no separate mcp.* subdomain)
3. Public GitHub repo for the service (extract services/agentready-woo-*/ from the private monorepo) — update repositories[0].url in server.json
4. README.md in the public repo listing the 5 tools (PulseMCP parses README to build its listing)

## After publish
- Smithery: publish at smithery.ai/new for faster inclusion; add DNS TXT record + backlink for vendor verification (score 65 -> 89)
- Glama: claim listing via GitHub OAuth
- mcpservers.org: /submit form (Marketing category exists)
- mcp.so: $39 — skip for now
