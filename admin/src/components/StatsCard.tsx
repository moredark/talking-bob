import { Card, Statistic } from "antd";
import type { ReactNode } from "react";

interface StatsCardProps {
  title: string;
  value: number | string | null;
  suffix?: string;
  icon?: ReactNode;
  loading?: boolean;
}

export function StatsCard({
  title,
  value,
  suffix,
  icon,
  loading,
}: StatsCardProps) {
  return (
    <Card loading={loading}>
      <Statistic
        title={title}
        value={value ?? "-"}
        suffix={suffix}
        prefix={icon}
      />
    </Card>
  );
}
