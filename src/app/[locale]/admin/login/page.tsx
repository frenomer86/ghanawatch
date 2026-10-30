import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { LoginForm } from "@/components/admin/login-form";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function AdminLoginPage({ params }: PageProps<"/[locale]/admin/login">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return (
    <AppShell>
      <div className="mx-auto max-w-sm">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">For moderators and administrators. Public users do not need an account.</p>
        <LoginForm />
      </div>
    </AppShell>
  );
}
