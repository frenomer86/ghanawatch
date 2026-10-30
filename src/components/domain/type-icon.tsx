import { CloudRain, Flame, Pickaxe, TreeDeciduous, Waves, type LucideProps } from "lucide-react";
import type { ChangeType } from "@/lib/domain/types";

const ICONS: Record<ChangeType, React.ComponentType<LucideProps>> = {
  vegetation_loss: TreeDeciduous,
  surface_disturbance: Pickaxe,
  water_change: Waves,
  flood_risk: CloudRain,
  fire: Flame,
};

/** Icon for a change type. Decorative when a visible label sits next to it; otherwise pass a `label`. */
export function TypeIcon({ type, label, className, ...rest }: { type: ChangeType; label?: string } & LucideProps) {
  const Icon = ICONS[type];
  return (
    <Icon
      className={className}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      strokeWidth={1.75}
      {...rest}
    />
  );
}
