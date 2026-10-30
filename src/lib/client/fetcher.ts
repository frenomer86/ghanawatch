"use client";

/** Shared SWR fetcher: JSON with error surfacing and offline detection. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public offline = false,
  ) {
    super(message);
  }
}

export async function fetcher<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch {
    throw new ApiError(0, "Network unavailable", true);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      message = body.message ?? message;
    } catch {
      /* body not JSON */
    }
    throw new ApiError(res.status, message, res.headers.get("x-sw-offline") === "1");
  }
  return res.json() as Promise<T>;
}

export const swrConfig = {
  fetcher,
  revalidateOnFocus: false,
  dedupingInterval: 15_000,
  errorRetryCount: 2,
};
