import {
  ArrowUpDown,
  Boxes,
  CircleDollarSign,
  Cable,
  Clock,
  Cpu,
  CloudCog,
  Database,
  FileCode,
  FileText,
  GitBranch,
  House,
  Layers,
  ChartPie,
  LayoutDashboard,
  Plus,
  Puzzle,
  Server,
  Settings,
  ShieldCheck,
  Ship,
  SlidersHorizontal,
  SquareTerminal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ARGO, COST, FLUX, HELM, OVERVIEW, PORT_FORWARDS, WORKLOADS_OVERVIEW } from "./nav";

/** Icons of Navigator sections (Lucide). */
export const NAV_ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  nodes: Server,
  workloads: Boxes,
  config: SlidersHorizontal,
  network: ArrowUpDown,
  storage: Database,
  namespaces: Layers,
  events: Clock,
  helm: Ship,
  access: ShieldCheck,
  custom: Puzzle,
  flux: CloudCog,
  argo: GitBranch,
  cost: CircleDollarSign,
  devices: Cpu,
};

/** Icon for a main tab, from the view id. */
export function viewIcon(id: string): LucideIcon {
  if (id === OVERVIEW) return LayoutDashboard;
  if (id === WORKLOADS_OVERVIEW) return ChartPie;
  if (id === PORT_FORWARDS) return Cable;
  if (id === HELM) return Ship;
  if (id === FLUX) return CloudCog;
  if (id === ARGO) return GitBranch;
  if (id === COST) return CircleDollarSign;
  if (id.startsWith("resource.k8s.io/")) return Cpu;
  if (id === "/nodes") return Server;
  if (id === "/namespaces") return Layers;
  if (id === "/events") return Clock;
  if (id === "catalog") return House;
  if (id === "settings") return Settings;
  return Boxes;
}

export const DOCK_ICONS: Record<string, LucideIcon> = {
  logs: FileText,
  shell: SquareTerminal,
  yaml: FileCode,
  create: Plus,
};
