import { projectId, publicAnonKey } from "../../utils/supabase/info";
import { supabase } from "./supabase";

const baseUrl = `https://${projectId}.supabase.co/functions/v1/make-server-cee2ad72`;

export type UserProfile = {
  id: string;
  fullName: string;
  phone: string;
  referralCode: string;
  referredBy: string;
  createdAt: string;
  kycStatus: "not_submitted" | "pending" | "approved" | "rejected";
  role: "user" | "admin";
};

export type SandboxAccount = {
  available: number;
  invested: number;
  currency: "TUSDT";
  updatedAt: string;
};

export type SandboxRequest = {
  id: string;
  userId: string;
  userName: string;
  type: "deposit" | "withdrawal";
  amount: number;
  detail: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
};

export type LedgerEntry = {
  id: string;
  userId: string;
  type: string;
  amount: number;
  availableAfter: number;
  investedAfter: number;
  note: string;
  createdAt: string;
};

export type SandboxInvestment = {
  id: string;
  userId: string;
  market: string;
  principal: number;
  status: "open" | "settled";
  createdAt: string;
  profit?: number;
};

async function request<T>(
  path: string,
  init: RequestInit = {},
  authenticated = false,
): Promise<T> {
  const session = authenticated
    ? (await supabase.auth.getSession()).data.session
    : null;
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token ?? publicAnonKey}`,
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "The request could not be completed.");
  }
  return data as T;
}

export async function validateReferral(code: string) {
  const data = await request<{ valid: boolean }>(
    `/referrals/${encodeURIComponent(code)}`,
  );
  return data.valid;
}

export async function createAccount(input: {
  fullName: string;
  phone: string;
  password: string;
  referralCode: string;
}) {
  return request<{ profile: UserProfile }>("/signup", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getProfile() {
  const data = await request<{ profile: UserProfile }>("/me", {}, true);
  return data.profile;
}

export async function getSandboxAccount() {
  return request<{ account: SandboxAccount; ledger: LedgerEntry[]; requests: SandboxRequest[] }>("/account", {}, true);
}

export async function createSandboxRequest(input: {
  type: "deposit" | "withdrawal";
  amount: number;
  detail: string;
}) {
  return request<{ request: SandboxRequest }>("/requests", {
    method: "POST",
    body: JSON.stringify(input),
  }, true);
}

export async function getAdminOverview() {
  return request<{
    profiles: UserProfile[];
    requests: SandboxRequest[];
    investments: SandboxInvestment[];
  }>("/admin/overview", {}, true);
}

export async function reviewSandboxRequest(id: string, decision: "approved" | "rejected") {
  return request<{ request: SandboxRequest }>(`/admin/requests/${id}`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  }, true);
}

export async function updateSandboxKyc(id: string, status: "approved" | "rejected" | "pending") {
  return request<{ profile: UserProfile }>(`/admin/users/${id}/kyc`, {
    method: "POST",
    body: JSON.stringify({ status }),
  }, true);
}

export async function allocateSandboxInvestment(userId: string, amount: number, market: string) {
  return request<{ investment: SandboxInvestment }>("/admin/investments", {
    method: "POST",
    body: JSON.stringify({ userId, amount, market }),
  }, true);
}

export async function settleSandboxInvestment(id: string, profit: number) {
  return request<{ investment: SandboxInvestment }>(`/admin/investments/${id}/settle`, {
    method: "POST",
    body: JSON.stringify({ profit }),
  }, true);
}
