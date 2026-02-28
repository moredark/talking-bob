import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Card,
  Descriptions,
  Table,
  Typography,
  Tag,
  Button,
  Spin,
  message,
  Space,
  Popconfirm,
  Select,
  Modal,
  Input,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ArrowLeftOutlined,
  StopOutlined,
  CheckOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { adminApi } from "../api/admin.api";
import type { UserDetail as UserDetailType, UserResponse } from "../types";

const { Title, Paragraph } = Typography;

const LANGUAGE_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

export function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [user, setUser] = useState<UserDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [banModalOpen, setBanModalOpen] = useState(false);
  const [banReason, setBanReason] = useState("");

  useEffect(() => {
    if (id) {
      loadUser(id);
    }
  }, [id]);

  const loadUser = async (userId: string) => {
    try {
      const data = await adminApi.getUserById(userId);
      setUser(data);
    } catch {
      message.error("Не удалось загрузить пользователя");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleDaily = async () => {
    if (!user || !id) return;
    setActionLoading(true);
    try {
      const updated = await adminApi.updateUser(id, {
        dailyPromptEnabled: !user.dailyPromptEnabled,
      });
      setUser(updated);
      message.success("Настройки обновлены");
    } catch {
      message.error("Не удалось обновить");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSetLevel = async (level: string | null) => {
    if (!id) return;
    setActionLoading(true);
    try {
      const updated = await adminApi.updateUser(id, {
        languageLevel: level,
      });
      setUser(updated);
      message.success("Уровень обновлён");
    } catch {
      message.error("Не удалось обновить");
    } finally {
      setActionLoading(false);
    }
  };

  const handleBan = async () => {
    if (!id) return;
    setActionLoading(true);
    try {
      const updated = await adminApi.updateUser(id, {
        status: "banned",
        bannedReason: banReason || undefined,
      });
      setUser(updated);
      setBanModalOpen(false);
      setBanReason("");
      message.success("Пользователь заблокирован");
    } catch {
      message.error("Не удалось заблокировать");
    } finally {
      setActionLoading(false);
    }
  };

  const handleUnban = async () => {
    if (!id) return;
    setActionLoading(true);
    try {
      const updated = await adminApi.updateUser(id, {
        status: "active",
      });
      setUser(updated);
      message.success("Пользователь разблокирован");
    } catch {
      message.error("Не удалось разблокировать");
    } finally {
      setActionLoading(false);
    }
  };

  const handleResetProgress = async () => {
    if (!id) return;
    setActionLoading(true);
    try {
      await adminApi.resetUserProgress(id);
      await loadUser(id);
      message.success("Прогресс сброшен");
    } catch {
      message.error("Не удалось сбросить прогресс");
    } finally {
      setActionLoading(false);
    }
  };

  const columns: ColumnsType<UserResponse> = [
    {
      title: "Тема",
      dataIndex: "promptTopic",
      key: "promptTopic",
    },
    {
      title: "Оценка",
      dataIndex: "overallScore",
      key: "overallScore",
      render: (score: number | null) =>
        score !== null ? (
          <Tag color={score >= 7 ? "green" : score >= 5 ? "orange" : "red"}>
            {score}/10
          </Tag>
        ) : (
          "-"
        ),
    },
    {
      title: "Транскрипция",
      dataIndex: "transcript",
      key: "transcript",
      render: (text: string | null) => (
        <Paragraph
          ellipsis={{ rows: 2 }}
          style={{ marginBottom: 0, maxWidth: 400 }}
        >
          {text || "-"}
        </Paragraph>
      ),
    },
    {
      title: "Дата",
      dataIndex: "createdAt",
      key: "createdAt",
      render: (date: string) => new Date(date).toLocaleString("ru-RU"),
    },
  ];

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: 50 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!user) {
    return <div>Пользователь не найден</div>;
  }

  const isBanned = user.status === "banned";

  return (
    <div>
      <Button
        icon={<ArrowLeftOutlined />}
        onClick={() => navigate("/users")}
        style={{ marginBottom: 16 }}
      >
        К списку
      </Button>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <Title level={4} style={{ margin: 0 }}>
          {user.username || `Пользователь ${user.telegramId}`}
          {isBanned && (
            <Tag color="red" style={{ marginLeft: 8 }}>
              Заблокирован
            </Tag>
          )}
        </Title>
        <Space>
          <Select
            placeholder="Уровень"
            value={user.languageLevel || undefined}
            onChange={handleSetLevel}
            allowClear
            style={{ width: 100 }}
            loading={actionLoading}
          >
            {LANGUAGE_LEVELS.map((level) => (
              <Select.Option key={level} value={level}>
                {level}
              </Select.Option>
            ))}
          </Select>

          <Button
            onClick={handleToggleDaily}
            loading={actionLoading}
            type={user.dailyPromptEnabled ? "default" : "primary"}
          >
            {user.dailyPromptEnabled ? "Выкл. рассылку" : "Вкл. рассылку"}
          </Button>

          {isBanned ? (
            <Button
              icon={<CheckOutlined />}
              onClick={handleUnban}
              loading={actionLoading}
            >
              Разблокировать
            </Button>
          ) : (
            <Button
              icon={<StopOutlined />}
              danger
              onClick={() => setBanModalOpen(true)}
              loading={actionLoading}
            >
              Заблокировать
            </Button>
          )}

          <Popconfirm
            title="Сбросить прогресс?"
            description="Все ответы и история будут удалены"
            onConfirm={handleResetProgress}
            okText="Да"
            cancelText="Нет"
          >
            <Button icon={<DeleteOutlined />} danger loading={actionLoading}>
              Сбросить прогресс
            </Button>
          </Popconfirm>
        </Space>
      </div>

      <Card style={{ marginBottom: 24 }}>
        <Descriptions column={{ xs: 1, sm: 2, md: 3 }}>
          <Descriptions.Item label="Telegram ID">
            {user.telegramId}
          </Descriptions.Item>
          <Descriptions.Item label="Имя пользователя">
            {user.username || "-"}
          </Descriptions.Item>
          <Descriptions.Item label="Рассылка">
            {user.dailyPromptEnabled ? (
              <Tag color="green">Включена</Tag>
            ) : (
              <Tag color="default">Выключена</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Время рассылки">
            {String(user.dailyPromptHour).padStart(2, "0")}:
            {String(user.dailyPromptMinute).padStart(2, "0")}
          </Descriptions.Item>
          <Descriptions.Item label="Часовой пояс">
            {user.timezone}
          </Descriptions.Item>
          <Descriptions.Item label="Уровень языка">
            {user.languageLevel || "-"}
          </Descriptions.Item>
          <Descriptions.Item label="Регистрация">
            {new Date(user.createdAt).toLocaleString("ru-RU")}
          </Descriptions.Item>
          <Descriptions.Item label="Получено промптов">
            {user.promptsReceived}
          </Descriptions.Item>
          <Descriptions.Item label="Ответов">
            {user.responsesCount}
          </Descriptions.Item>
          <Descriptions.Item label="Средняя оценка">
            {user.averageScore !== null ? `${user.averageScore}/10` : "-"}
          </Descriptions.Item>
          {user.bannedAt && (
            <Descriptions.Item label="Заблокирован">
              {new Date(user.bannedAt).toLocaleString("ru-RU")}
            </Descriptions.Item>
          )}
          {user.bannedReason && (
            <Descriptions.Item label="Причина блокировки">
              {user.bannedReason}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Title level={5}>Ответы</Title>
      <Table
        columns={columns}
        dataSource={user.responses}
        rowKey="id"
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title="Заблокировать пользователя"
        open={banModalOpen}
        onOk={handleBan}
        onCancel={() => {
          setBanModalOpen(false);
          setBanReason("");
        }}
        okText="Заблокировать"
        cancelText="Отмена"
        confirmLoading={actionLoading}
      >
        <Input.TextArea
          placeholder="Причина блокировки (необязательно)"
          value={banReason}
          onChange={(e) => setBanReason(e.target.value)}
          rows={3}
        />
      </Modal>
    </div>
  );
}
