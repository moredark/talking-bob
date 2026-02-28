import { useEffect, useState } from "react";
import { Table, Typography, Tag, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { adminApi } from "../api/admin.api";
import type { TopicStats } from "../types";

const { Title } = Typography;

export function Topics() {
  const [topics, setTopics] = useState<TopicStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTopics();
  }, []);

  const loadTopics = async () => {
    try {
      const data = await adminApi.getTopics();
      setTopics(data);
    } catch {
      message.error("Не удалось загрузить темы");
    } finally {
      setLoading(false);
    }
  };

  const columns: ColumnsType<TopicStats> = [
    {
      title: "Тема",
      dataIndex: "topic",
      key: "topic",
    },
    {
      title: "Статус",
      dataIndex: "isActive",
      key: "isActive",
      render: (active: boolean) =>
        active ? (
          <Tag color="green">Активна</Tag>
        ) : (
          <Tag color="default">Неактивна</Tag>
        ),
      filters: [
        { text: "Активна", value: true },
        { text: "Неактивна", value: false },
      ],
      onFilter: (value, record) => record.isActive === value,
    },
    {
      title: "Отправлено",
      dataIndex: "timesSent",
      key: "timesSent",
      sorter: (a, b) => a.timesSent - b.timesSent,
    },
    {
      title: "Ответов",
      dataIndex: "responsesCount",
      key: "responsesCount",
      sorter: (a, b) => a.responsesCount - b.responsesCount,
    },
    {
      title: "Конверсия",
      dataIndex: "responseRate",
      key: "responseRate",
      render: (rate: number) => `${rate}%`,
      sorter: (a, b) => a.responseRate - b.responseRate,
    },
    {
      title: "Ср. оценка",
      dataIndex: "averageScore",
      key: "averageScore",
      render: (score: number | null) =>
        score !== null ? (
          <Tag color={score >= 7 ? "green" : score >= 5 ? "orange" : "red"}>
            {score}/10
          </Tag>
        ) : (
          "-"
        ),
      sorter: (a, b) => (a.averageScore ?? 0) - (b.averageScore ?? 0),
    },
  ];

  return (
    <div>
      <Title level={4}>Статистика по темам</Title>
      <Table
        columns={columns}
        dataSource={topics}
        rowKey="id"
        loading={loading}
        pagination={false}
      />
    </div>
  );
}
