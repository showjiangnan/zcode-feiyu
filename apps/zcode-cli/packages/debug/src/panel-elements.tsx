// Modified by ZCode Feiyu.
import type { ReactNode } from "react";

export function PanelTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function EmptyLine({ text }: { text: string }) {
  return <p className="empty-line">{text}</p>;
}

export function MetaLine({ values }: { values: string[] }) {
  const cleanValues = values.filter(Boolean);
  if (cleanValues.length === 0) return null;
  return <small className="meta-line">{cleanValues.join(" · ")}</small>;
}
