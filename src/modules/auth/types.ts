export type AccountRow = {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  auth_provider: string;
  status: string;
  created_at: Date;
};

export type SessionAccount = AccountRow & {
  session_id: string;
};

export type GoogleUserInfo = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};
