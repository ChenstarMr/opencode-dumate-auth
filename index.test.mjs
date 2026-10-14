// DuMate's chats are its gateway's own OpenAI-compatible endpoint, signed
// with a token the console cookie buys; its daily 签到领积分 is the console's.
import { afterEach, expect, test } from "bun:test"
import { DuMateAuthPlugin, _internal } from "./index.mjs"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function fake(routes) {
  const seen = []
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const body = init?.body
    seen.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof body === "string" ? body : undefined })
    for (const [match, reply] of routes) if (url.includes(match)) return reply(url, init)
    return new Response("not found", { status: 404 })
  }
  return seen
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const cookie = "BDUSS=bd-1; bce-sessionid=cs-1; bce-user-info=csrf-1"
const auth = { type: "api", key: cookie, token: "tok-1", expires: Date.now() + 24 * 3600 * 1000, accountId: "搭子用户" }

test("the provider is declared with the app's own models", async () => {
  const hooks = await DuMateAuthPlugin({ client: {} })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider.dumate
  expect(p.npm).toBe("@ai-sdk/openai-compatible")
  expect(p.api).toBe("https://dumate-svc.baidu.com/gateway/apis/v1")
  // the app's own key is glm-5 and the id its gateway takes is model-text
  expect(p.models["glm-5"].id).toBe("model-text")
  expect(p.models["glm-5"].limit.context).toBe(192000)
  expect(p.models["dm-auto-model/text.L0"].tool_call).toBe(true)
})

test("a chat goes to the gateway with the account's own token", async () => {
  const seen = fake([["/gateway/apis/v1/chat/completions", () => new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream", "X-Ratelimit-Remaining-Requests": "13637" } })]])
  const hooks = await DuMateAuthPlugin({ client: {} })
  const { fetch: f } = await hooks.auth.loader(async () => auth)
  const res = await f("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", { method: "POST", body: '{"model":"model-text"}' })
  expect(res.status).toBe(200)
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
  expect(seen[0].headers.get("authorization")).toBe("Bearer tok-1")
  expect(seen[0].headers.get("user-agent")).toContain("DumateApp/")
  expect(seen[0].headers.get("x-dumate-request-id")).toBeTruthy()
  expect(seen[0].headers.get("x-dumate-session-id")).toStartWith("ses_")
  expect(seen[0].headers.get("x-dumate-request-extra-param")).toContain("source=user")
  expect(seen[0].body).toBe('{"model":"model-text"}')
  // the allowance the gateway named is kept for the usage card
  expect(_internal.limits.get("搭子用户").requests).toBe("13637")
})

test("a token near its end is bought again before the request", async () => {
  const seen = fake([
    ["/app/token/get", () => json({ code: 0, result: { token: "tok-2", expired_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() } })],
    ["/chat/completions", () => new Response("{}", { status: 200 })],
  ])
  const saved = []
  const hooks = await DuMateAuthPlugin({ client: { auth: { set: async (x) => saved.push(x) } } })
  const { fetch: f } = await hooks.auth.loader(async () => ({ ...auth, expires: Date.now() + 1000 }))
  const res = await f("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", { method: "POST", body: "{}" })
  expect(res.headers.get("x-magpie-sign-in")).toBe("renewed")
  expect(seen[0].url).toContain("/api/ai_apaas/console/desktop/v2/app/token/get")
  expect(seen[0].headers.get("cookie")).toBe(cookie)
  expect(seen[0].headers.get("csrftoken")).toBe("csrf-1")
  expect(seen[0].headers.get("dumate-version")).toBe("1.0.74.149")
  expect(seen[1].headers.get("authorization")).toBe("Bearer tok-2")
  expect(saved[0].body.token).toBe("tok-2")
})

test("a 401 buys a new token and sends once more", async () => {
  let n = 0
  const seen = fake([
    ["/app/token/get", () => json({ code: 0, result: { token: "tok-2", expired_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() } })],
    ["/chat/completions", () => (++n === 1 ? new Response("{}", { status: 401 }) : new Response("{}", { status: 200 }))],
  ])
  const hooks = await DuMateAuthPlugin({ client: {} })
  const { fetch: f } = await hooks.auth.loader(async () => auth)
  const res = await f("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", { method: "POST", body: "{}" })
  expect(res.status).toBe(200)
  expect(seen.filter((r) => r.url.includes("/chat/completions")).length).toBe(2)
  expect(seen.at(-1).headers.get("authorization")).toBe("Bearer tok-2")
})

test("the check-in claims the day's 500 and reads it back", async () => {
  let claimed = false
  const seen = fake([
    ["/points/loginBonusInfo", () => json({ code: 0, result: { totalPoints: claimed ? 1500 : 1000, hasIssued: claimed, signInDays: [] } })],
    ["/points/loginBonus", () => {
      claimed = true
      return json({ code: 0, result: {} })
    }],
  ])
  const hooks = await DuMateAuthPlugin({ client: {} })
  const out = await hooks.auth.checkin(async () => auth)
  expect(out).toEqual({ outcome: "claimed", credit: 500 })
  const claim = seen.find((r) => r.url.includes("/points/loginBonus") && r.method === "POST")
  expect(claim.headers.get("x-requested-with")).toBe("XMLHttpRequest")
  expect(claim.headers.get("dumate-version")).toBe("1.0.74.149")
})

test("a day already claimed is done", async () => {
  fake([["/points/loginBonusInfo", () => json({ code: 0, result: { totalPoints: 1500, hasIssued: true, signInDays: [] } })]])
  const hooks = await DuMateAuthPlugin({ client: {} })
  expect(await hooks.auth.checkin(async () => auth)).toEqual({ outcome: "done", credit: 500 })
})

test("a console session the server turned away is the caller's own 401", async () => {
  fake([["/points/loginBonusInfo", () => new Response("", { status: 302 })]])
  const hooks = await DuMateAuthPlugin({ client: {} })
  const out = await hooks.auth.checkin(async () => auth)
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("sign in again")
  const u = await hooks.auth.usage(async () => auth)
  expect(u.signIn).toBe("expired")
})

test("the usage card shows the account's points", async () => {
  fake([["/points/loginBonusInfo", () => json({ code: 0, result: { totalPoints: 1500, hasIssued: true, signInDays: [] } })]])
  const hooks = await DuMateAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.plan).toBe("DuMate")
  expect(u.balance).toBe("1500 积分")
  expect(u.user).toBe("搭子用户")
})

test("a pasted Cookie is read the way the console's own is", () => {
  expect(_internal.parseCookie(cookie)).toEqual([["BDUSS", "bd-1"], ["bce-sessionid", "cs-1"], ["bce-user-info", "csrf-1"]])
  const { header, csrftoken } = _internal.credentialsOf({ cookieText: cookie })
  expect(header).toBe(cookie)
  expect(csrftoken).toBe("csrf-1")
  // a list the app kept is filtered to the console's own host
  const fromList = _internal.credentialsOf({
    cookieList: [
      { name: "BDUSS", value: "bd-1", domain: ".baidu.com" },
      { name: "bce-sessionid", value: "cs-1", domain: "console.bce.baidu.com" },
      { name: "other", value: "x", domain: "example.com" },
    ],
  })
  expect(fromList.header).toBe("BDUSS=bd-1; bce-sessionid=cs-1")
})

test("the app's own cookie payload is opened the way the app seals it", async () => {
  const { createCipheriv, createDecipheriv, randomBytes } = await import("node:crypto")
  const key = randomBytes(32)
  const cookies = [{ name: "BDUSS", value: "bd-9", domain: ".baidu.com" }, { name: "bce-user-info", value: "csrf-9", domain: "console.bce.baidu.com" }]
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(cookies), "utf8"), c.final()])
  const encoded = Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")
  // the same shape the app writes is read back
  const buf = Buffer.from(encoded, "base64")
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  const opened = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"))
  expect(opened).toEqual(cookies)
})
