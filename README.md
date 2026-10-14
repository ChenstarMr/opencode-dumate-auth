# DuMate (百度搭子)

An [OpenCode](https://opencode.ai) / [magpie](https://usemagpie.ai) provider plugin for **DuMate** (百度搭子), Baidu's own agent app. Its provider id is `dumate`.

## What it signs in to

A Baidu Smart Cloud account, the same one the DuMate app uses. Two ways:

- **DuMate console Cookie** — paste the Cookie you have after signing in to `console.bce.baidu.com`. It is checked by buying a gateway token with it.
- **Use the DuMate app's sign-in** — the console cookie the app keeps, opened from `%APPDATA%\qianfan-desktop-app\auth.json` (AES-256-GCM under the 32-byte key in `.cookie-key`, laid out `iv12|tag16|ciphertext`). Nothing is written back to the app.

The sign-in is kept in magpie's `plugin-auth.json` (or OpenCode's `auth.json`), like any plugin's. The console cookie is the credential; the gateway token (`GET /api/ai_apaas/console/desktop/v2/app/token/get`) is bought with it and renewed before the end the server names — the app's own logs show 9.8 h to 24 h, so nothing is assumed.

## Models

The app keeps no model list to ask: it declares its own. This package declares the names its own requests carry — `glm-5` (sent as `model-text`), `dm-auto-model/text.L0`, `dm-auto-model/mm.L0` and `qwen3.5-35b-a3b`. They speak chat completions with tools, and reasoning arrives as `reasoning_content`.

Chats go to `dumate-svc.baidu.com/gateway/apis/v1/chat/completions` with the gateway token — the endpoint the app's own local proxy forwards to.

## Daily check-in

The console's 「每日签到领积分」 (+500 积分 a day) is claimed through `/api/dumate/points/…`. Settings → Usage → Plugins has the switch; the result shows on the account's Usage card, with the account's points.

## Notes

- The gateway names the account's allowance on every answer (`X-Ratelimit-Remaining-Requests` / `-Tokens`), and the Usage card shows what was last seen.
- The console cookie must be the whole set from `console.bce.baidu.com`; a bare `BDUSS` is answered with a redirect.
- The plugin does not run the app, and the app may be closed.

## Install

```sh
magpie plugin add @magpie-community/opencode-dumate-auth
magpie plugin login dumate
```

In OpenCode, add `@magpie-community/opencode-dumate-auth` to `opencode.json`'s `plugin` and run `opencode auth login`.
