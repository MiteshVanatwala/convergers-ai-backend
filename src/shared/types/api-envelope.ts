export type ApiSuccessEnvelope<T> = {
  success: true;
  status_code: number;
  data: T;
};

export type ApiErrorEnvelope = {
  success: false;
  status_code: number;
  error: string;
};

export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;
