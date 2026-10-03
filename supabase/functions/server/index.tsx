import { createClient } from "jsr:@supabase/supabase-js@2.49.8";
import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import * as kv from "./kv_store.tsx";

const app = new Hono();
const api = "/make-server-cee2ad72";
const foundingInvite = "NI-A8M2K9";
const currency = "TUSDT" as const;

type KycStatus = "not_submitted" | "pending" | "approved" | "rejected";
type UserRole = "user" | "admin";
type RequestStatus = "pending" | "approved" | "rejected";
type RequestType = "deposit" | "withdrawal";

type UserProfile = {
  id: string;
  fullName: string;
  phone: string;
  referralCode: string;
  referredBy: string;
  createdAt: string;
  kycStatus: KycStatus;
  role: UserRole;
};

type SandboxAccount = {
  available: number;
  invested: number;
  currency: typeof currency;
  updatedAt: string;
};

type SandboxRequest = {
  id: string;
  userId: string;
  userName: string;
  type: RequestType;
  amount: number;
  detail: string;
  status: RequestStatus;
  createdAt: string;
};

type LedgerEntry = {
  id: string;
  userId: string;
  type: string;
  amount: number;
  availableAfter: number;
  investedAfter: number;
  note: string;
  createdAt: string;
};

type SandboxInvestment = {
  id: string;
  userId: string;
  market: string;
  principal: number;
  status: "open" | "settled";
  createdAt: string;
  profit?: number;
  settledAt?: string;
};

type AuthContext = {
  userId: string;
  profile: UserProfile;
};

app.use("*", logger(console.log));
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

function now() {
  return new Date().toISOString();
}

function profileKey(userId: string) {
  return `profile:${userId}`;
}

function accountKey(userId: string) {
  return `account:${userId}`;
}

function referralKey(code: string) {
  return `referral:${code}`;
}

function requestKey(id: string) {
  return `request:${id}`;
}

function ledgerKey(userId: string, id: string) {
  return `ledger:${userId}:${id}`;
}

function investmentKey(id: string) {
  return `investment:${id}`;
}

function jsonError(c: any, status: number, error: string) {
  return c.json({ error }, status);
}

function normalizePhone(value: unknown) {
  const normalized = String(value ?? "").replace(/[^\d+]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

function normalizeReferral(value: unknown) {
  const code = String(value ?? "").trim().toUpperCase();
  return /^NI-[A-Z0-9]{6}$/.test(code) ? code : null;
}

function positiveAmount(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0
    ? Math.round(amount * 100) / 100
    : null;
}

function finiteMoney(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}

async function parseBody(c: any) {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

async function authenticate(c: any): Promise<AuthContext | null> {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;

  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data.user) return null;

  const profile = await kv.get(profileKey(data.user.id)) as UserProfile | undefined;
  if (!profile) return null;
  return { userId: data.user.id, profile };
}

async function requireAuth(c: any) {
  const auth = await authenticate(c);
  if (!auth) return { response: jsonError(c, 401, "Authentication required.") };
  return { auth };
}

async function requireAdmin(c: any) {
  const result = await requireAuth(c);
  if ("response" in result) return result;
  if (result.auth.profile.role !== "admin") {
    return { response: jsonError(c, 403, "Administrator access required.") };
  }
  return result;
}

async function isValidReferral(code: string) {
  if (code === foundingInvite) {
    return !(await kv.get("system:founding-invite-claimed"));
  }
  return Boolean(await kv.get(referralKey(code)));
}

async function generateReferralCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const suffix = Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
    const code = `NI-${suffix}`;
    if (!(await kv.get(referralKey(code)))) return code;
  }
  throw new Error("A unique referral code could not be generated.");
}

function newAccount(): SandboxAccount {
  return {
    available: 0,
    invested: 0,
    currency,
    updatedAt: now(),
  };
}

function ledgerEntry(
  userId: string,
  account: SandboxAccount,
  type: string,
  amount: number,
  note: string,
): LedgerEntry {
  return {
    id: crypto.randomUUID(),
    userId,
    type,
    amount,
    availableAfter: account.available,
    investedAfter: account.invested,
    note,
    createdAt: now(),
  };
}

app.get(`${api}/health`, (c) => {
  return c.json({ status: "ok", mode: "sandbox" });
});

app.get(`${api}/referrals/:code`, async (c) => {
  const code = normalizeReferral(c.req.param("code"));
  return c.json({ valid: code ? await isValidReferral(code) : false });
});

app.post(`${api}/signup`, async (c) => {
  const body = await parseBody(c);
  if (!body) return jsonError(c, 400, "A valid JSON body is required.");

  const fullName = String(body.fullName ?? "").trim().replace(/\s+/g, " ");
  const phone = normalizePhone(body.phone);
  const password = String(body.password ?? "");
  const referredBy = normalizeReferral(body.referralCode);

  if (fullName.length < 2 || fullName.length > 100) {
    return jsonError(c, 400, "Enter a valid full name.");
  }
  if (!phone) return jsonError(c, 400, "Enter a valid international mobile number.");
  if (password.length < 8 || password.length > 72) {
    return jsonError(c, 400, "Password must contain between 8 and 72 characters.");
  }
  if (!referredBy || !(await isValidReferral(referredBy))) {
    return jsonError(c, 400, "The referral code is invalid or has already been used.");
  }

  const role: UserRole = referredBy === foundingInvite ? "admin" : "user";
  const referralCode = await generateReferralCode();
  const createdAt = now();
  const supabase = adminClient();
  const { data, error } = await supabase.auth.admin.createUser({
    phone,
    password,
    phone_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (error || !data.user) {
    const duplicate = error?.message.toLowerCase().includes("already");
    return jsonError(
      c,
      duplicate ? 409 : 400,
      duplicate
        ? "An account already exists for this mobile number."
        : (error?.message ?? "The account could not be created."),
    );
  }

  const profile: UserProfile = {
    id: data.user.id,
    fullName,
    phone,
    referralCode,
    referredBy,
    createdAt,
    kycStatus: "not_submitted",
    role,
  };

  const keys = [
    profileKey(profile.id),
    accountKey(profile.id),
    referralKey(referralCode),
  ];
  const values: unknown[] = [
    profile,
    newAccount(),
    { userId: profile.id, createdAt },
  ];

  if (role === "admin") {
    keys.push("system:founding-invite-claimed");
    values.push({ userId: profile.id, createdAt });
  }

  try {
    await kv.mset(keys, values);
  } catch (storageError) {
    await supabase.auth.admin.deleteUser(profile.id);
    console.error("Account rollback after storage failure", storageError);
    return jsonError(c, 500, "The account could not be initialized.");
  }

  return c.json({ profile }, 201);
});

app.get(`${api}/me`, async (c) => {
  const result = await requireAuth(c);
  if ("response" in result) return result.response;
  return c.json({ profile: result.auth.profile });
});

app.get(`${api}/account`, async (c) => {
  const result = await requireAuth(c);
  if ("response" in result) return result.response;

  const account = (await kv.get(accountKey(result.auth.userId)) as SandboxAccount | undefined)
    ?? newAccount();
  const ledger = await kv.getByPrefix(`ledger:${result.auth.userId}:`) as LedgerEntry[];
  const requests = (await kv.getByPrefix("request:") as SandboxRequest[])
    .filter((item) => item.userId === result.auth.userId);

  return c.json({ account, ledger, requests });
});

app.post(`${api}/requests`, async (c) => {
  const result = await requireAuth(c);
  if ("response" in result) return result.response;
  const body = await parseBody(c);
  if (!body) return jsonError(c, 400, "A valid JSON body is required.");

  const type = body.type as RequestType;
  const amount = positiveAmount(body.amount);
  const detail = String(body.detail ?? "").trim().slice(0, 300);
  if (type !== "deposit" && type !== "withdrawal") {
    return jsonError(c, 400, "Request type must be deposit or withdrawal.");
  }
  if (!amount) return jsonError(c, 400, "Enter a valid amount.");
  if (!detail) return jsonError(c, 400, "A reference or wallet detail is required.");

  if (type === "withdrawal") {
    if (result.auth.profile.kycStatus !== "approved") {
      return jsonError(c, 403, "KYC approval is required before requesting a withdrawal.");
    }
    const account = (await kv.get(accountKey(result.auth.userId)) as SandboxAccount | undefined)
      ?? newAccount();
    const requests = (await kv.getByPrefix("request:") as SandboxRequest[])
      .filter((item) =>
        item.userId === result.auth.userId
        && item.type === "withdrawal"
        && item.status === "pending"
      );
    const reserved = requests.reduce((total, item) => total + item.amount, 0);
    if (amount > account.available - reserved) {
      return jsonError(c, 400, "The requested amount exceeds the available test balance.");
    }
  }

  const request: SandboxRequest = {
    id: crypto.randomUUID(),
    userId: result.auth.userId,
    userName: result.auth.profile.fullName,
    type,
    amount,
    detail,
    status: "pending",
    createdAt: now(),
  };
  await kv.set(requestKey(request.id), request);
  return c.json({ request }, 201);
});

app.get(`${api}/admin/overview`, async (c) => {
  const result = await requireAdmin(c);
  if ("response" in result) return result.response;
  const [profiles, requests, investments] = await Promise.all([
    kv.getByPrefix("profile:") as Promise<UserProfile[]>,
    kv.getByPrefix("request:") as Promise<SandboxRequest[]>,
    kv.getByPrefix("investment:") as Promise<SandboxInvestment[]>,
  ]);
  return c.json({ profiles, requests, investments });
});

app.post(`${api}/admin/requests/:id`, async (c) => {
  const result = await requireAdmin(c);
  if ("response" in result) return result.response;
  const body = await parseBody(c);
  const decision = body?.decision as "approved" | "rejected";
  if (decision !== "approved" && decision !== "rejected") {
    return jsonError(c, 400, "Decision must be approved or rejected.");
  }

  const id = c.req.param("id");
  const request = await kv.get(requestKey(id)) as SandboxRequest | undefined;
  if (!request) return jsonError(c, 404, "Request not found.");
  if (request.status !== "pending") {
    return jsonError(c, 409, "This request has already been reviewed.");
  }

  const reviewedRequest = { ...request, status: decision } as SandboxRequest;
  if (decision === "rejected") {
    await kv.set(requestKey(id), reviewedRequest);
    return c.json({ request: reviewedRequest });
  }

  const account = (await kv.get(accountKey(request.userId)) as SandboxAccount | undefined)
    ?? newAccount();
  if (request.type === "withdrawal" && request.amount > account.available) {
    return jsonError(c, 409, "The user no longer has enough available test credit.");
  }

  const updatedAccount: SandboxAccount = {
    ...account,
    available: Math.round(
      (account.available + (request.type === "deposit" ? request.amount : -request.amount)) * 100,
    ) / 100,
    updatedAt: now(),
  };
  const entry = ledgerEntry(
    request.userId,
    updatedAccount,
    request.type,
    request.type === "deposit" ? request.amount : -request.amount,
    `${request.type === "deposit" ? "Deposit" : "Withdrawal"} request approved by sandbox admin.`,
  );
  await kv.mset(
    [requestKey(id), accountKey(request.userId), ledgerKey(request.userId, entry.id)],
    [reviewedRequest, updatedAccount, entry],
  );
  return c.json({ request: reviewedRequest });
});

app.post(`${api}/admin/users/:id/kyc`, async (c) => {
  const result = await requireAdmin(c);
  if ("response" in result) return result.response;
  const body = await parseBody(c);
  const status = body?.status as KycStatus;
  if (!["pending", "approved", "rejected"].includes(status)) {
    return jsonError(c, 400, "Invalid KYC status.");
  }

  const id = c.req.param("id");
  const profile = await kv.get(profileKey(id)) as UserProfile | undefined;
  if (!profile) return jsonError(c, 404, "User not found.");
  const updatedProfile = { ...profile, kycStatus: status };
  await kv.set(profileKey(id), updatedProfile);
  return c.json({ profile: updatedProfile });
});

app.post(`${api}/admin/investments`, async (c) => {
  const result = await requireAdmin(c);
  if ("response" in result) return result.response;
  const body = await parseBody(c);
  if (!body) return jsonError(c, 400, "A valid JSON body is required.");

  const userId = String(body.userId ?? "");
  const amount = positiveAmount(body.amount);
  const market = String(body.market ?? "").trim().slice(0, 120);
  if (!userId || !amount || !market) {
    return jsonError(c, 400, "User, amount, and market are required.");
  }
  const profile = await kv.get(profileKey(userId)) as UserProfile | undefined;
  if (!profile) return jsonError(c, 404, "User not found.");
  const account = (await kv.get(accountKey(userId)) as SandboxAccount | undefined)
    ?? newAccount();
  if (amount > account.available) {
    return jsonError(c, 400, "The user does not have enough available test credit.");
  }

  const updatedAccount: SandboxAccount = {
    ...account,
    available: Math.round((account.available - amount) * 100) / 100,
    invested: Math.round((account.invested + amount) * 100) / 100,
    updatedAt: now(),
  };
  const investment: SandboxInvestment = {
    id: crypto.randomUUID(),
    userId,
    market,
    principal: amount,
    status: "open",
    createdAt: now(),
  };
  const entry = ledgerEntry(
    userId,
    updatedAccount,
    "investment_allocated",
    -amount,
    `Allocated to ${market}.`,
  );
  await kv.mset(
    [accountKey(userId), investmentKey(investment.id), ledgerKey(userId, entry.id)],
    [updatedAccount, investment, entry],
  );
  return c.json({ investment }, 201);
});

app.post(`${api}/admin/investments/:id/settle`, async (c) => {
  const result = await requireAdmin(c);
  if ("response" in result) return result.response;
  const body = await parseBody(c);
  const profit = finiteMoney(body?.profit);
  if (profit === null) return jsonError(c, 400, "Enter a valid profit or loss.");

  const id = c.req.param("id");
  const investment = await kv.get(investmentKey(id)) as SandboxInvestment | undefined;
  if (!investment) return jsonError(c, 404, "Investment not found.");
  if (investment.status !== "open") {
    return jsonError(c, 409, "This investment has already been settled.");
  }
  if (investment.principal + profit < 0) {
    return jsonError(c, 400, "A loss cannot exceed the invested principal.");
  }

  const account = (await kv.get(accountKey(investment.userId)) as SandboxAccount | undefined)
    ?? newAccount();
  if (account.invested < investment.principal) {
    return jsonError(c, 409, "The invested test balance is inconsistent.");
  }
  const updatedAccount: SandboxAccount = {
    ...account,
    available: Math.round((account.available + investment.principal + profit) * 100) / 100,
    invested: Math.round((account.invested - investment.principal) * 100) / 100,
    updatedAt: now(),
  };
  const settledInvestment: SandboxInvestment = {
    ...investment,
    status: "settled",
    profit,
    settledAt: now(),
  };
  const entry = ledgerEntry(
    investment.userId,
    updatedAccount,
    "investment_settled",
    profit,
    `${investment.market} settled; principal returned with test profit/loss.`,
  );
  await kv.mset(
    [
      accountKey(investment.userId),
      investmentKey(id),
      ledgerKey(investment.userId, entry.id),
    ],
    [updatedAccount, settledInvestment, entry],
  );
  return c.json({ investment: settledInvestment });
});

app.notFound((c) => jsonError(c, 404, "Endpoint not found."));
app.onError((error, c) => {
  console.error("Unhandled NOVA sandbox backend error", error);
  return jsonError(c, 500, "An unexpected server error occurred.");
});

Deno.serve(app.fetch);
