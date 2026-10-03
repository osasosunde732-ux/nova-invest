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
