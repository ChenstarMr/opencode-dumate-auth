// OpenCode provider plugin for DuMate (百度搭子), Baidu's own agent app. An
// account signs in with a Baidu Smart Cloud console cookie — pasted, or read
// from the app's own encrypted auth.json — which buys the app's gateway token
// (GET /api/ai_apaas/console/desktop/v2/app/token/get, a UUID with an end the
// server names). Its chats are OpenAI chat completions at
// dumate-svc.baidu.com/gateway/apis/v1, sent with that token, so this plugin
// only signs the requests and hands the answers on. Its daily check-in
// (「每日签到领积分」, +500 积分 a day) is claimed on the console API.
import { createDecipheriv, randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const ID = "dumate"
const NAME = "DuMate"
const CONSOLE = "https://console.bce.baidu.com"
const GATEWAY = "https://dumate-svc.baidu.com"
const API = GATEWAY + "/gateway/apis/v1"
const NPM = "@ai-sdk/openai-compatible"
const CLIENT_VERSION = "1.0.74.149"
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
const APP_DIR = join(homedir(), "AppData", "Roaming", "qianfan-desktop-app")
const AUTH_FILE = join(APP_DIR, "auth.json")
const KEY_FILE = join(APP_DIR, ".cookie-key")
const TOKEN_PATH = "/api/ai_apaas/console/desktop/v2/app/token/get"
const BONUS_INFO = "/api/dumate/points/loginBonusInfo"
const BONUS_CLAIM = "/api/dumate/points/loginBonus"
const DAILY_BONUS = 500
const EARLY_MS = 10 * 60 * 1000 // a gateway token this close to its end is renewed first
const LEAD_MS = 30 * 60 * 1000

const str = (o, k) => (typeof o?.[k] === "string" && o[k].trim() ? o[k].trim() : undefined)
const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined)

// ---- the console cookie ------------------------------------------------------

// parseCookie takes a pasted Cookie header (or a few pairs, or lines) as pairs,
// in the order they came.
function parseCookie(text) {
  const out = []
  const seen = new Set()
  for (const seg of String(text ?? "").split(/[;\n\r]+/)) {
    const s = seg.trim()
    if (!s) continue
    const i = s.indexOf("=")
    if (i <= 0) continue
    const name = s.slice(0, i).trim()
    const value = s.slice(i + 1).trim().replace(/^["']|["']$/g, "")
    if (!name || /^(path|domain|expires|max-age|samesite|secure|httponly)$/i.test(name)) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push([name, value])
  }
  return out
}

const domainMatches = (domain, host) => {
  if (!domain) return true
  const d = String(domain).replace(/^\./, "")
  return host === d || host.endsWith("." + d)
}

// credentialsOf is the cookie header and csrftoken the console is asked with.
// The list the app keeps is filtered to the console's own host; a pasted one —
// kept as the sign-in's key, or as a header — is taken as it is.
function credentialsOf(auth) {
  let pairs = []
  if (Array.isArray(auth?.cookieList) && auth.cookieList.length) {
    pairs = auth.cookieList
      .filter((c) => c && c.name && domainMatches(c.domain, "console.bce.baidu.com"))
      .map((c) => [String(c.name), String(c.value ?? "").replace(/^["']+|["']+$/g, "")])
  } else if (str(auth, "cookieText")) {
    pairs = parseCookie(auth.cookieText)
  } else if (str(auth, "key")) {
    pairs = parseCookie(auth.key)
  }
  const header = pairs.map(([k, v]) => k + "=" + (/[:|;=\s]/.test(v) ? `"${v}"` : v)).join("; ")
  const csrf = pairs.find(([k]) => k === "bce-user-info")
  return { header, csrftoken: csrf ? csrf[1].replace(/^["']+|["']+$/g, "") : "" }
}

// consoleRequest asks the console as the app does. A 302 is the console's own
// way of saying the session is gone.
async function consoleRequest(auth, path, { method = "GET", body } = {}) {
  const { header, csrftoken } = credentialsOf(auth)
  if (!header) throw new Error(`${NAME} has no cookie; sign in again`)
  const res = await fetch(CONSOLE + path, {
    method,
    headers: {
      Accept: "application/json, text/plain, */*",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-Requested-With": "XMLHttpRequest",
      Origin: CONSOLE,
      Referer: CONSOLE + "/",
      "dumate-version": CLIENT_VERSION,
      Cookie: header,
      "User-Agent": UA,
      ...(csrftoken ? { csrftoken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  })
  if (res.status === 301 || res.status === 302 || res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`${NAME}'s console session is gone; sign in again`), { signIn: "expired" })
  }
  const text = await res.text()
  let parsed
  try {
    parsed = obj(JSON.parse(text))
  } catch {}
  if (!res.ok) throw new Error(`${NAME}: HTTP ${res.status}`)
  if (!parsed) throw new Error(`${NAME}: not JSON`)
  if (parsed.code !== undefined && Number(parsed.code) !== 0) throw new Error(`${NAME}: ${str(parsed, "message") ?? "code " + parsed.code}`)
  return parsed
}

// gatewayToken trades the console cookie for the gateway's own token, and the
// end the server names with it.
async function gatewayToken(auth) {
  const body = await consoleRequest(auth, TOKEN_PATH)
  const r = obj(body.result) ?? {}
  const token = str(r, "token")
  if (!token) throw new Error(`${NAME} sent no gateway token`)
  const ends = str(r, "expired_at")
  return { token, expires: ends ? Date.parse(ends) : 0 }
}

async function userInfo(auth) {
  const body = await consoleRequest(auth, "/api/dumate/user/info")
  const d = obj(body.result) ?? {}
  return { userId: String(d.userId ?? ""), bceUserId: String(d.bceUserId ?? ""), displayName: str(d, "displayName") ?? "" }
}

async function bonusInfo(auth) {
  const body = await consoleRequest(auth, BONUS_INFO)
  const d = obj(body.result) ?? {}
  return {
    totalTimes: num(d.totalTimes) ?? 0,
    totalPoints: num(d.totalPoints) ?? 0,
    hasIssued: d.hasIssued === true,
    signInDays: Array.isArray(d.signInDays) ? d.signInDays : [],
  }
}

// ---- the app's own sign-in (Windows) -----------------------------------------

// appAuth opens the cookie list the app keeps: AES-256-GCM under the key in
// .cookie-key, laid out iv12|tag16|ciphertext.
function appAuth() {
  if (!existsSync(AUTH_FILE)) throw new Error(`no ${AUTH_FILE}; install and sign in to ${NAME} first`)
  if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE}`)
  const key = readFileSync(KEY_FILE)
  if (key.length !== 32) throw new Error(`${KEY_FILE} is not a 32-byte key`)
  const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8"))
  const profiles = Array.isArray(auth.accountProfiles) ? auth.accountProfiles : []
  const profile = profiles.find((p) => p && p.profileId === auth.activeProfileId) ?? profiles[0]
  const encoded = profile?.encryptedCookies ?? auth.cookies
  if (!encoded) throw new Error(`the ${NAME} app has no cookie saved; sign in to it first`)
  const buf = Buffer.from(String(encoded), "base64")
  if (buf.length < 28) throw new Error("the app's cookie payload is too short")
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  const plain = Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")
  const cookies = JSON.parse(plain)
  if (!Array.isArray(cookies)) throw new Error("the app's cookie payload is not a list")
  const list = cookies
    .filter((c) => c && c.name && domainMatches(c.domain, "console.bce.baidu.com"))
    .map((c) => ({ name: String(c.name), value: String(c.value ?? ""), domain: String(c.domain ?? "") }))
  if (!list.length) throw new Error(`the ${NAME} app has no console cookie; sign in to it first`)
  return { list, profile: profile ? { displayName: str(profile, "displayName") ?? "", bceUserId: str(profile, "bceUserId") ?? "" } : {} }
}

// ---- the models -------------------------------------------------------------

// DuMate keeps no model list: the app declares its own and the gateway serves
// the names it knows. These are the ones its own logs carry.
const MODELS = [
  { id: "dm-auto-model/text.L0", name: "Auto (text)", context: 192000, output: 64000, images: false },
  { id: "dm-auto-model/mm.L0", name: "Auto (multimodal)", context: 192000, output: 64000, images: true },
  { id: "glm-5", api: "model-text", name: "GLM-5", context: 192000, output: 128000, images: false },
  { id: "qwen3.5-35b-a3b", name: "Qwen3.5-35B-A3B", context: 128000, output: 32000, images: false },
]

const modelConfig = (m) => ({
  name: m.name,
  ...(m.api ? { id: m.api } : {}),
  reasoning: true,
  tool_call: true,
  attachment: !!m.images,
  modalities: { input: m.images ? ["text", "image"] : ["text"], output: ["text"] },
  limit: { context: m.context ?? 0, output: m.output ?? 0 },
  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
})

function configModels() {
  return Object.fromEntries(MODELS.map((m) => [m.id, modelConfig(m)]))
}

function modelOf(provider, m) {
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.api ?? m.id, url: API, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: !!m.images,
      toolcall: true,
      input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
  }
}

// signedIn says whether the account has a console cookie at all, whichever way
// it was signed in.
const signedIn = (auth) => !!credentialsOf(auth).header

// ---- the daily check-in (「每日签到领积分」) ----

const today = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function checkin(getAuth) {
  const auth = await getAuth()
  if (!signedIn(auth)) return { outcome: "ineligible", message: `${NAME} isn't signed in` }
  let before
  try {
    before = await bonusInfo(auth)
  } catch (e) {
    return { outcome: "failed", message: e?.message ?? String(e) }
  }
  if (before.hasIssued || before.signInDays.includes(today())) return { outcome: "done", credit: DAILY_BONUS }
  await consoleRequest(auth, BONUS_CLAIM, { method: "POST", body: {} })
  const after = await bonusInfo(auth).catch(() => undefined)
  if (after && (after.hasIssued || after.signInDays.includes(today()))) {
    const gained = after.totalPoints > before.totalPoints ? after.totalPoints - before.totalPoints : DAILY_BONUS
    return { outcome: "claimed", credit: gained }
  }
  return { outcome: "failed", message: "the check-in did not take" }
}

// ---- the plugin -------------------------------------------------------------

// the newest rate-limit the gateway named, per account, as its own answer
// carried it; the usage card reads it back
const limits = new Map()

export const DuMateAuthPlugin = async ({ client }) => {
  const save = async (a) => {
    if (typeof client?.auth?.set !== "function") return false
    try {
      await client.auth.set({ path: { id: ID }, body: a })
      return true
    } catch {
      return false
    }
  }

  // fresh is the account with a gateway token that isn't about to end, bought
  // (and saved) when it is, or when the gateway turned the one in hand away.
  const fresh = async (getAuth, rejected) => {
    const stored = await getAuth()
    if (!stored) throw new Error(`${NAME} isn't signed in`)
    if (rejected !== undefined && stored.token && stored.token !== rejected) return { a: stored, renewed: true }
    const near = stored.expires && Date.now() >= stored.expires - EARLY_MS
    if (rejected === undefined && stored.token && !near) return { a: stored, renewed: false }
    const { token, expires } = await gatewayToken(stored)
    const a = { ...stored, token, expires }
    await save(a)
    return { a, renewed: true }
  }

  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider[ID] ??= {}
      const p = config.provider[ID]
      p.name ??= NAME
      p.npm ??= NPM
      p.api ??= API
      p.models = { ...configModels(), ...(p.models ?? {}) }
    },

    provider: {
      id: ID,
      // the app keeps no list to ask; what it serves is what it declares
      async models(provider) {
        return provider.models
      },
    },

    auth: {
      provider: ID,
      refreshLead: LEAD_MS,
      async refresh(auth) {
        if (!signedIn(auth)) return undefined
        const { token, expires } = await gatewayToken(auth)
        return { token, expires }
      },
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        return {
          baseURL: API,
          apiKey: "dumate",
          async fetch(input, init = {}) {
            const req = input instanceof Request ? input : undefined
            let body = init?.body
            if (body === undefined && req) body = await req.clone().text()
            const send = (a) => {
              const headers = new Headers(init?.headers ?? req?.headers)
              headers.delete("content-length")
              headers.set("Authorization", "Bearer " + a.token)
              headers.set("Accept", "text/event-stream, application/json")
              headers.set("User-Agent", `${UA} DumateApp/${CLIENT_VERSION}`)
              headers.set("X-Dumate-Request-Id", randomUUID())
              if (!headers.has("X-Dumate-Session-Id")) headers.set("X-Dumate-Session-Id", "ses_" + randomUUID().replace(/-/g, "").slice(0, 24))
              if (a.deviceId) headers.set("X-Dumate-Device-Id", a.deviceId)
              headers.set("X-Dumate-Request-Extra-Param", "sandbox=false, source=user")
              return fetch(req ? req.url : input, { ...init, method: init?.method ?? req?.method ?? "POST", headers, body })
            }
            let { a, renewed } = await fresh(getAuth)
            let res = await send(a)
            if (res.status === 401) {
              ;({ a } = await fresh(getAuth, a.token))
              renewed = true
              res = await send(a)
            }
            // the gateway names the account's allowance on every answer
            const limit = res.headers.get("x-ratelimit-remaining-requests")
            if (limit) limits.set(a.accountId ?? ID, { requests: limit, tokens: res.headers.get("x-ratelimit-remaining-tokens"), at: Date.now() })
            const headers = new Headers(res.headers)
            headers.set("X-Magpie-Sign-In", res.status === 401 ? "expired" : renewed ? "renewed" : "kept")
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
          },
        }
      },
      // the account's points, and the allowance the gateway last named
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth) return { error: "not signed in" }
        try {
          const info = await bonusInfo(auth)
          const seen = limits.get(auth.accountId ?? ID)
          return {
            plan: "DuMate",
            balance: `${info.totalPoints} 积分`,
            windows: seen?.requests ? [{ name: "Requests", used: 0, resetsAt: new Date(seen.at + 24 * 3600 * 1000).toISOString(), span: 24 * 3600 }] : [],
            user: auth.displayName || auth.userId || auth.accountId || undefined,
            signIn: "kept",
          }
        } catch (e) {
          return { error: e?.message ?? String(e), ...(e?.signIn ? { signIn: e.signIn } : { signIn: "kept" }) }
        }
      },
      checkin,
      methods: [
        {
          type: "api",
          label: `${NAME} console Cookie`,
          placeholder: "BDUSS=…; bce-sessionid=…; bce-user-info=…",
          // the cookie is checked by buying a gateway token with it
          async authorize(inputs) {
            const text = String(inputs?.key ?? "").trim()
            const pairs = parseCookie(text)
            const names = new Set(pairs.map(([n]) => n))
            if (!names.has("BDUSS") && !names.has("bce-sessionid")) {
              return { type: "failed", error: "the Cookie needs BDUSS or bce-sessionid, from console.bce.baidu.com" }
            }
            const draft = { cookieText: text }
            try {
              const { token, expires } = await gatewayToken(draft)
              const info = await userInfo(draft).catch(() => ({}))
              const csrf = pairs.find(([n]) => n === "bce-user-info")?.[1] ?? ""
              return {
                type: "success",
                key: text,
                metadata: { token, expires, csrftoken: csrf, ...info },
              }
            } catch (e) {
              return { type: "failed", error: `${NAME} refused the Cookie: ${e?.message ?? e}` }
            }
          },
        },
        {
          type: "oauth",
          label: `Use the ${NAME} app's sign-in`,
          async authorize() {
            return {
              url: "",
              instructions: `The console cookie the ${NAME} app keeps is opened as it is.`,
              method: "auto",
              async callback() {
                try {
                  const { list, profile } = appAuth()
                  const draft = { cookieList: list }
                  const { token, expires } = await gatewayToken(draft)
                  const info = await userInfo(draft).catch(() => ({}))
                  return {
                    type: "success",
                    access: list.map((c) => `${c.name}=${c.value}`).join("; "),
                    refresh: "",
                    accountId: info.displayName || profile.displayName || info.userId || NAME,
                    cookieList: list,
                    token,
                    expires,
                    ...profile,
                    ...info,
                  }
                } catch (e) {
                  return { type: "failed", error: `${NAME} app sign-in: ${e?.message ?? e}` }
                }
              },
            }
          },
        },
      ],
    },
  }
}

// for tests
export const _internal = { MODELS, configModels, modelOf, parseCookie, credentialsOf, consoleRequest, gatewayToken, userInfo, bonusInfo, appAuth, checkin, limits, today }
