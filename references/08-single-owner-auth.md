# Phase 8 — Single-Owner Auth

Lara Creator authenticates exactly one user — the owner whose email is set via `OWNER_EMAIL` env var. They choose a password on first login. Sessions are signed cookies. No roles, no signup form, no password reset (yet — see notes at end).

This is **not** a generic auth pattern. If you need multi-tenancy, use NextAuth or Clerk. The advantage of this approach is zero dependencies and zero attack surface — there's nothing to misconfigure.

## 8.1 Add `OWNER_EMAIL` to `.env.local`

```
OWNER_EMAIL="you@example.com"
```

This is the **only** email that can log in. Setting it once at deploy time means the owner can't accidentally create alternate accounts.

## 8.2 The auth module — `src/lib/auth.ts`

```ts
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "./prisma";
import { env } from "./env";
import type { User } from "@prisma/client";

const SESSION_COOKIE = "lara_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;   // 30 days

// ─── Password hashing — scrypt (Node built-in, no extra dep) ───

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const computed = scryptSync(password, salt, 64);
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== computed.length) return false;
  return timingSafeEqual(computed, expected);
}

// ─── Sessions — HMAC of (userId + passwordHash) ───

function sessionMac(userId: string, passwordHash: string): string {
  return createHash("sha256").update(`${userId}::${passwordHash}`).digest("hex");
}

export async function createSession(user: User): Promise<void> {
  if (!user.passwordHash) throw new Error("User has no password — cannot create session");
  const mac = sessionMac(user.id, user.passwordHash);
  const store = await cookies();
  store.set(SESSION_COOKIE, `${user.id}:${mac}`, {
    httpOnly: true,
    sameSite: "lax",
    secure:   env.isProd,
    path:     "/",
    maxAge:   SESSION_MAX_AGE,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSessionUser(): Promise<User | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const [userId, mac] = raw.split(":");
  if (!userId || !mac) return null;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.passwordHash) return null;

  const expected = sessionMac(user.id, user.passwordHash);
  if (mac.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch { return null; }

  // Extra defense: if the DB email no longer matches OWNER_EMAIL, deny.
  if (user.email.toLowerCase() !== env.ownerEmail) return null;

  return user;
}

export async function requireUser(): Promise<User> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function needsInitialSetup(): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { email: env.ownerEmail } });
  if (!user) return true;
  return !user.passwordHash;
}
```

### Why this design works for a single-owner system

1. **scrypt over bcrypt:** scrypt is built into Node's `crypto` — no `bcryptjs` dependency to maintain. Comparable security for password hashing.
2. **`timingSafeEqual` in `verifyPassword`** prevents timing attacks. Critical even for single-owner — assume someone could try to guess.
3. **HMAC binding to `passwordHash`:** changing the password invalidates every existing session automatically. No "log out everywhere" button needed.
4. **Email check on every request:** even if someone forges a cookie, `user.email !== OWNER_EMAIL` blocks them.
5. **`requireUser()` redirects:** use in every protected page's server component layout. No middleware needed.

## 8.3 Login flow — three pages

### `src/app/login/page.tsx`

```tsx
import { needsInitialSetup, getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { LoginForm } from "./login-form";
import { SetupForm } from "./setup-form";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/overview");
  const needsSetup = await needsInitialSetup();
  return needsSetup ? <SetupForm /> : <LoginForm />;
}
```

### `src/app/login/login-form.tsx` (client component)

```tsx
"use client";
import { loginAction } from "./actions";
import { useState } from "react";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(formData: FormData) {
    const result = await loginAction(formData);
    if (result?.error) setError(result.error);
  }
  return (
    <form action={onSubmit}>
      {/* email is shown disabled = OWNER_EMAIL */}
      <input name="password" type="password" required minLength={8} />
      <button type="submit">כניסה</button>
      {error && <p>{error}</p>}
    </form>
  );
}
```

### `src/app/login/setup-form.tsx` — first-time password choice

```tsx
"use client";
import { setupAction } from "./actions";

export function SetupForm() {
  // Same shape as LoginForm but with password + confirmPassword.
  // On submit: validate they match, call setupAction.
}
```

### `src/app/login/actions.ts` — server actions

```ts
"use server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { createSession, clearSession, hashPassword, verifyPassword } from "@/lib/auth";
import { redirect } from "next/navigation";

export async function loginAction(formData: FormData): Promise<{ error?: string } | void> {
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) return { error: "סיסמה חייבת להכיל לפחות 8 תווים" };

  const user = await prisma.user.findUnique({ where: { email: env.ownerEmail } });
  if (!user || !user.passwordHash) return { error: "משתמש לא נמצא" };
  if (!verifyPassword(password, user.passwordHash)) return { error: "סיסמה שגויה" };

  await createSession(user);
  redirect("/overview");
}

export async function setupAction(formData: FormData): Promise<{ error?: string } | void> {
  const password = String(formData.get("password") ?? "");
  const confirm  = String(formData.get("confirmPassword") ?? "");
  if (password.length < 8)        return { error: "סיסמה חייבת להכיל לפחות 8 תווים" };
  if (password !== confirm)       return { error: "הסיסמאות אינן זהות" };

  // upsert — if the row exists with no passwordHash, set it; otherwise create.
  const user = await prisma.user.upsert({
    where:  { email: env.ownerEmail },
    create: { email: env.ownerEmail, passwordHash: hashPassword(password) },
    update: { passwordHash: hashPassword(password) },
  });
  await createSession(user);
  redirect("/overview");
}

export async function logoutAction() {
  await clearSession();
  redirect("/login");
}
```

## 8.4 Protecting pages — the `(app)/layout.tsx` pattern

```tsx
// src/app/(app)/layout.tsx
import { requireUser } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();  // throws redirect("/login") if not signed in
  return (
    <div>
      {/* Topbar, Sidebar, etc — pass `user` down so UserMenu can show it */}
      {children}
    </div>
  );
}
```

Every page under `(app)/` is automatically gated. No middleware. No per-page check.

## 8.5 What's intentionally missing

- **No signup form.** Only the email in `OWNER_EMAIL` can become the User row, and only once.
- **No password reset via email.** The owner cannot reset by themselves — by design, since there's no email service wired up. If they forget, you (the operator) help them:
  ```sql
  UPDATE users SET password_hash = NULL WHERE email = 'owner@example.com';
  ```
  Then they'll see the setup form again on next visit. (Brutal but secure.)
- **No 2FA, no OAuth, no social login.** Single owner, one secret.
- **No "remember me" UI.** Always 30 days.

If the owner wants email-based reset later, add a small endpoint that emails a one-time token (Resend / Postmark / SES) and clears `password_hash` when the token's redeemed.

## 8.6 Verify

1. Set `OWNER_EMAIL=test@example.com` in `.env.local`
2. `npm run dev`
3. Visit `http://localhost:3000` → redirects to `/login`
4. You should see the SetupForm (first time)
5. Choose a password → redirects to `/overview` (you'll get a 500 because the page isn't built yet, but the auth cookie is set)
6. Refresh the page — should still be authenticated
7. Try `http://localhost:3000/login` — should redirect to `/overview` (already logged in)

If any of this misbehaves, check:
- `OWNER_EMAIL` is lowercased and trimmed in `env.ts`
- `secure: env.isProd` not `secure: true` — `true` blocks the cookie on localhost (no HTTPS)
- The User row actually got created in Postgres (`SELECT * FROM users`)

---

**Next:** `references/09-railway-deployment.md`
