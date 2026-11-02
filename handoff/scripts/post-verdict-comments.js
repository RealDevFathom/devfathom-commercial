export const meta = {
  name: 'post-verdict-comments',
  description: 'Post prepared QA/Security verdict comments verbatim, after head and duplicate checks',
  phases: [{ title: 'Post', detail: 'one poster per PR' }],
}
const RES = {
  type: 'object',
  properties: {
    posted: { type: 'boolean' },
    url: { type: 'string' },
    headSha: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['posted', 'reason'],
}
const prompt = (p) => `Post one prepared verdict comment on pull request #${p.n} in RealDevFathom/devfathom-commercial (owner "realdevfathom", repo "devfathom-commercial").

Steps:
1. Load tools with ToolSearch query "select:mcp__github__pull_request_read,mcp__github__add_issue_comment".
2. Call mcp__github__pull_request_read method "get" for pullNumber ${p.n}. If the PR is not open, its base is not develop, or its head sha does not start with "${p.head}", do NOT post; return posted=false with the reason and the actual head sha.
3. Call mcp__github__pull_request_read method "get_comments" (perPage 100, all pages). If any existing comment already contains a verdict in the form "QA: PASS" or "QA: FAIL" together with "Security: PASS" or "Security: FAIL", do NOT post; return posted=false, reason "verdict comment already exists" plus its URL.
4. Read the file ${p.bodyPath} with the Read tool. Post its exact contents, byte for byte with no additions, edits or extra footer, as the body of mcp__github__add_issue_comment with issue_number ${p.n}.
5. Return posted=true, the comment URL, and the head sha you saw.
Do nothing else: no other comments, reviews, labels or edits.`
const results = await parallel(args.map((p) => () => agent(prompt(p), { label: `post#${p.n}`, phase: 'Post', schema: RES, effort: 'low' }).then((r) => ({ n: p.n, ...r }))))
return results.filter(Boolean)
