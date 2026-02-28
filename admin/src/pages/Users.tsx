import { useEffect, useState } from "react";
import { Table, Typography, Tag, message } from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { useNavigate } from "react-router-dom";
import { adminApi } from "../api/admin.api";
import type { UserListItem } from "../types";

const { Title } = Typography;

export function Users() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState<TablePaginationConfig>({
    current: 1,
    pageSize: 20,
    total: 0,
  });

  useEffect(() => {
    loadUsers(1, 20);
  }, []);

  const loadUsers = async (page: number, limit: number) => {
    setLoading(true);
    try {
      const data = await adminApi.getUsers(page, limit);
      setUsers(data.data);
      setPagination({
        current: data.page,
        pageSize: data.limit,
        total: data.total,
      });
    } catch {
      message.error("Не удалось загрузить пользователей");
    } finally {
      setLoading(false);
    }
  };

  const handleTableChange = (newPagination: TablePaginationConfig) => {
    loadUsers(newPagination.current || 1, newPagination.pageSize || 20);
  };

  const columns: ColumnsType<UserListItem> = [
    {
      title: "Имя",
      dataIndex: "username",
      key: "username",
      render: (username: string | null) => username || "-",
    },
    {
      title: "Telegram ID",
      dataIndex: "telegramId",
      key: "telegramId",
    },
    {
      title: "Промптов",
      dataIndex: "promptsReceived",
      key: "promptsReceived",
      sorter: (a, b) => a.promptsReceived - b.promptsReceived,
    },
    {
      title: "Ответов",
      dataIndex: "responsesCount",
      key: "responsesCount",
      sorter: (a, b) => a.responsesCount - b.responsesCount,
    },
    {
      title: "Ср. оценка",
      dataIndex: "averageScore",
      key: "averageScore",
      render: (score: number | null) =>
        score !== null ? `${score}/10` : "-",
      sorter: (a, b) => (a.averageScore ?? 0) - (b.averageScore ?? 0),
    },
    {
      title: "Рассылка",
      dataIndex: "dailyPromptEnabled",
      key: "dailyPromptEnabled",
      render: (enabled: boolean) =>
        enabled ? (
          <Tag color="green">Вкл</Tag>
        ) : (
          <Tag color="default">Выкл</Tag>
        ),
      filters: [
        { text: "Вкл", value: true },
        { text: "Выкл", value: false },
      ],
      onFilter: (value, record) => record.dailyPromptEnabled === value,
    },
    {
      title: "Активность",
      dataIndex: "lastActivityAt",
      key: "lastActivityAt",
      render: (date: string | null) =>
        date ? new Date(date).toLocaleDateString("ru-RU") : "Нет",
      sorter: (a, b) => {
        if (!a.lastActivityAt) return 1;
        if (!b.lastActivityAt) return -1;
        return (
          new Date(a.lastActivityAt).getTime() -
          new Date(b.lastActivityAt).getTime()
        );
      },
    },
    {
      title: "Регистрация",
      dataIndex: "createdAt",
      key: "createdAt",
      render: (date: string) => new Date(date).toLocaleDateString("ru-RU"),
      sorter: (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    },
  ];

  return (
    <div>
      <Title level={4}>Пользователи</Title>
      <Table
        columns={columns}
        dataSource={users}
        rowKey="id"
        loading={loading}
        pagination={pagination}
        onChange={handleTableChange}
        onRow={(record) => ({
          onClick: () => navigate(`/users/${record.id}`),
          style: { cursor: "pointer" },
        })}
      />
    </div>
  );
}
