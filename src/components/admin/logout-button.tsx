"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  const router = useRouter();
  return (
    <Button
      variant="outline"
      onClick={async () => {
        await fetch("/api/v1/auth/logout", { method: "POST" });
        try {
          navigator.serviceWorker?.controller?.postMessage({ type: "clear-api-cache" });
        } catch {
          // no service worker: nothing cached on this device
        }
        router.push("/admin/login");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
