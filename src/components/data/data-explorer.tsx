"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import useSWR from "swr";
import { Download, FileJson } from "lucide-react";
import { fetcher } from "@/lib/client/fetcher";
import { CHANGE_TYPES, CONFIDENCES, SEVERITIES, type ChangeEventSummary } from "@/lib/domain/types";
import { formatHectares } from "@/lib/domain/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { SeverityBadge } from "@/components/domain/severity-badge";
import { Link } from "@/i18n/navigation";

type Page = { items: ChangeEventSummary[]; nextCursor: string | null };

/**
 * Filter → preview table → download. The same query string drives the
 * preview and the CSV/GeoJSON export so what you see is what you get.
 */
export function DataExplorer({ regions }: { regions: string[] }) {
  const t = useTranslations("data");
  const tType = useTranslations("type");
  const tSev = useTranslations("severity");
  const tConf = useTranslations("confidence");
  const tc = useTranslations("common");
  const locale = useLocale();
  const today = new Date().toISOString().slice(0, 10);
  const ninety = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(ninety);
  const [to, setTo] = useState(today);
  const [type, setType] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [confidence, setConfidence] = useState("all");
  const [region, setRegion] = useState("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const base = useMemo(() => {
    const sp = new URLSearchParams();
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) sp.set("from", from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) sp.set("to", to);
    if (type !== "all") sp.set("type", type);
    if (severity !== "all") sp.set("severity", severity);
    if (confidence !== "all") sp.set("confidence", confidence);
    if (region !== "all") sp.set("region", region);
    return sp;
  }, [from, to, type, severity, confidence, region]);

  const previewKey = (() => {
    const sp = new URLSearchParams(base);
    sp.set("limit", "25");
    sp.set("lang", locale);
    if (cursor) sp.set("cursor", cursor);
    return `/api/v1/events?${sp}`;
  })();
  const { data, isLoading, error } = useSWR<Page>(previewKey, fetcher, { keepPreviousData: true });
  const csvHref = `/api/v1/events?${new URLSearchParams([...base.entries(), ["format", "csv"]])}`;
  const geoHref = `/api/v1/events?${new URLSearchParams([...base.entries(), ["format", "geojson"]])}`;

  const resetPaging = () => {
    setCursor(null);
    setHistory([]);
  };

  return (
    <section className="mt-8">
      <div className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-6">
        <Field label={t("from")} id="d-from">
          <Input id="d-from" type="date" value={from} max={to} onChange={(e) => (setFrom(e.target.value), resetPaging())} />
        </Field>
        <Field label={t("to")} id="d-to">
          <Input id="d-to" type="date" value={to} min={from} max={today} onChange={(e) => (setTo(e.target.value), resetPaging())} />
        </Field>
        <Field label={tType("label")} id="d-type">
          <Select value={type} onValueChange={(v) => (setType(v), resetPaging())}>
            <SelectTrigger id="d-type">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {CHANGE_TYPES.map((v) => (
                <SelectItem key={v} value={v}>
                  {tType(v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={tSev("label")} id="d-sev">
          <Select value={severity} onValueChange={(v) => (setSeverity(v), resetPaging())}>
            <SelectTrigger id="d-sev">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {SEVERITIES.map((v) => (
                <SelectItem key={v} value={v}>
                  {tSev(v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={tConf("label")} id="d-conf">
          <Select value={confidence} onValueChange={(v) => (setConfidence(v), resetPaging())}>
            <SelectTrigger id="d-conf">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {CONFIDENCES.map((v) => (
                <SelectItem key={v} value={v}>
                  {tConf(v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("columns.region")} id="d-region">
          <Select value={region} onValueChange={(v) => (setRegion(v), resetPaging())}>
            <SelectTrigger id="d-region">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {regions.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button asChild>
          <a href={csvHref} download>
            <Download className="size-4" aria-hidden />
            {t("downloadCsv")}
          </a>
        </Button>
        <Button asChild variant="outline">
          <a href={geoHref} download>
            <FileJson className="size-4" aria-hidden />
            {t("downloadGeojson")}
          </a>
        </Button>
        <p className="text-sm text-muted-foreground">
          {t("licence")}: CC BY 4.0. {t("citeAs")}: GhanaWatch ({new Date().getFullYear()}), environmental change detections for Ghana [data set]
        </p>
      </div>

      <div className="mt-6 rounded-xl border bg-card" role="region" aria-label={t("title")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.date")}</TableHead>
              <TableHead>{t("columns.detected")}</TableHead>
              <TableHead>{t("columns.type")}</TableHead>
              <TableHead>{t("columns.severity")}</TableHead>
              <TableHead>{t("columns.confidence")}</TableHead>
              <TableHead>{t("columns.district")}</TableHead>
              <TableHead>{t("columns.region")}</TableHead>
              <TableHead className="text-right">{t("columns.area")}</TableHead>
              <TableHead>{t("columns.source")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && !data
              ? Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={9}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : data?.items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="tabular-nums">
                      <Link href={`/event/${e.id}`} className="text-link underline">
                        {e.imageDate}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{e.detectedAt.slice(0, 16).replace("T", " ")}</TableCell>
                    <TableCell>{tType(e.type)}</TableCell>
                    <TableCell>
                      <SeverityBadge severity={e.severity} size="sm" />
                    </TableCell>
                    <TableCell>{tConf(e.confidence)}</TableCell>
                    <TableCell>{e.districtName ?? "–"}</TableCell>
                    <TableCell>{e.regionName ?? "–"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatHectares(e.areaHa)}</TableCell>
                    <TableCell className="text-muted-foreground">{e.sourceSlug}</TableCell>
                  </TableRow>
                ))}
            {data && data.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  {t("records", { count: 0 })}
                </TableCell>
              </TableRow>
            )}
            {error && (
              <TableRow>
                <TableCell colSpan={9} className="py-6 text-center text-sev-urgent">
                  {tc("error")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm">
        <Button
          variant="ghost"
          size="sm"
          disabled={history.length === 0}
          onClick={() => {
            const prev = [...history];
            const c = prev.pop() ?? null;
            setHistory(prev);
            setCursor(c);
          }}
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!data?.nextCursor}
          onClick={() => {
            setHistory([...history, cursor ?? ""]);
            setCursor(data?.nextCursor ?? null);
          }}
        >
          Next
        </Button>
      </div>
    </section>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
