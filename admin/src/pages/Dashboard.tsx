import { useEffect, useState } from "react";
import { Row, Col, Typography, message } from "antd";
import {
  UserOutlined,
  MessageOutlined,
  StarOutlined,
  PercentageOutlined,
  CalendarOutlined,
  BellOutlined,
} from "@ant-design/icons";
import { StatsCard } from "../components/StatsCard";
import { adminApi } from "../api/admin.api";
import type { DashboardStats } from "../types";

const { Title } = Typography;

export function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const data = await adminApi.getDashboard();
      setStats(data);
    } catch {
      message.error("Не удалось загрузить статистику");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Title level={4}>Дашборд</Title>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <StatsCard
            title="Всего пользователей"
            value={stats?.totalUsers ?? null}
            icon={<UserOutlined />}
            loading={loading}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatsCard
            title="Активных (7 дн)"
            value={stats?.activeUsers ?? null}
            icon={<UserOutlined />}
            loading={loading}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatsCard
            title="Новых (7 дн)"
            value={stats?.newUsersThisWeek ?? null}
            icon={<CalendarOutlined />}
            loading={loading}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatsCard
            title="С рассылкой"
            value={stats?.usersWithDailyEnabled ?? null}
            icon={<BellOutlined />}
            loading={loading}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatsCard
            title="Отправлено промптов"
            value={stats?.totalPromptsSent ?? null}
            icon={<MessageOutlined />}
            loading={loading}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatsCard
            title="Всего ответов"
            value={stats?.totalResponses ?? null}
            icon={<MessageOutlined />}
            loading={loading}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatsCard
            title="Конверсия"
            value={stats?.responseRate ?? null}
            suffix="%"
            icon={<PercentageOutlined />}
            loading={loading}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatsCard
            title="Средняя оценка"
            value={stats?.averageScore ?? null}
            suffix="/10"
            icon={<StarOutlined />}
            loading={loading}
          />
        </Col>
      </Row>
    </div>
  );
}
