import { useEffect, useState } from "react";
import {
  Table,
  Typography,
  Tag,
  Button,
  Space,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  InputNumber,
  message,
  Popconfirm,
} from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { adminApi } from "../api/admin.api";
import type { PromptItem, CreatePromptDto, UpdatePromptDto } from "../types";

const { Title } = Typography;

const DIFFICULTIES = [
  { value: "easy", label: "Лёгкий" },
  { value: "medium", label: "Средний" },
  { value: "hard", label: "Сложный" },
];

const AVAILABLE_TAGS = [
  "grammar",
  "vocabulary",
  "tense",
  "pronunciation",
  "fluency",
  "conversation",
];

export function Prompts() {
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState<TablePaginationConfig>({
    current: 1,
    pageSize: 20,
    total: 0,
  });
  const [modalOpen, setModalOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<PromptItem | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadPrompts(1, 20);
  }, []);

  const loadPrompts = async (page: number, limit: number) => {
    setLoading(true);
    try {
      const data = await adminApi.getPrompts(page, limit);
      setPrompts(data.data);
      setPagination({
        current: data.page,
        pageSize: data.limit,
        total: data.total,
      });
    } catch {
      message.error("Не удалось загрузить промпты");
    } finally {
      setLoading(false);
    }
  };

  const handleTableChange = (newPagination: TablePaginationConfig) => {
    loadPrompts(newPagination.current || 1, newPagination.pageSize || 20);
  };

  const handleCreate = () => {
    setEditingPrompt(null);
    form.resetFields();
    form.setFieldsValue({
      difficulty: "medium",
      isActive: true,
      sortOrder: 0,
      tags: [],
    });
    setModalOpen(true);
  };

  const handleEdit = (prompt: PromptItem) => {
    setEditingPrompt(prompt);
    form.setFieldsValue({
      topic: prompt.topic,
      textContent: prompt.textContent,
      audioFileId: prompt.audioFileId,
      difficulty: prompt.difficulty,
      tags: prompt.tags,
      isActive: prompt.isActive,
      sortOrder: prompt.sortOrder,
    });
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await adminApi.deletePrompt(id);
      message.success("Промпт удалён");
      loadPrompts(pagination.current || 1, pagination.pageSize || 20);
    } catch {
      message.error("Не удалось удалить промпт");
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);

      if (editingPrompt) {
        const updateData: UpdatePromptDto = {
          topic: values.topic,
          textContent: values.textContent || undefined,
          audioFileId: values.audioFileId?.trim() || null,
          difficulty: values.difficulty,
          tags: values.tags,
          isActive: values.isActive,
          sortOrder: values.sortOrder,
        };
        await adminApi.updatePrompt(editingPrompt.id, updateData);
        message.success("Промпт обновлён");
      } else {
        const createData: CreatePromptDto = {
          topic: values.topic,
          textContent: values.textContent || undefined,
          audioFileId: values.audioFileId?.trim() || null,
          difficulty: values.difficulty,
          tags: values.tags,
          isActive: values.isActive,
          sortOrder: values.sortOrder,
        };
        await adminApi.createPrompt(createData);
        message.success("Промпт создан");
      }

      setModalOpen(false);
      loadPrompts(pagination.current || 1, pagination.pageSize || 20);
    } catch {
      message.error("Не удалось сохранить промпт");
    } finally {
      setSaving(false);
    }
  };

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case "easy":
        return "green";
      case "medium":
        return "orange";
      case "hard":
        return "red";
      default:
        return "default";
    }
  };

  const getDifficultyLabel = (difficulty: string) => {
    return DIFFICULTIES.find((d) => d.value === difficulty)?.label || difficulty;
  };

  const columns: ColumnsType<PromptItem> = [
    {
      title: "Тема",
      dataIndex: "topic",
      key: "topic",
    },
    {
      title: "Текст",
      dataIndex: "textContent",
      key: "textContent",
      render: (text: string | null) => text || "-",
      ellipsis: true,
      width: 200,
    },
    {
      title: "Сложность",
      dataIndex: "difficulty",
      key: "difficulty",
      render: (difficulty: string) => (
        <Tag color={getDifficultyColor(difficulty)}>
          {getDifficultyLabel(difficulty)}
        </Tag>
      ),
      filters: DIFFICULTIES.map((d) => ({ text: d.label, value: d.value })),
      onFilter: (value, record) => record.difficulty === value,
    },
    {
      title: "Теги",
      dataIndex: "tags",
      key: "tags",
      render: (tags: string[]) =>
        tags.length > 0 ? tags.map((tag) => <Tag key={tag}>{tag}</Tag>) : "-",
    },
    {
      title: "Статус",
      dataIndex: "isActive",
      key: "isActive",
      render: (active: boolean) =>
        active ? (
          <Tag color="green">Активен</Tag>
        ) : (
          <Tag color="default">Неактивен</Tag>
        ),
      filters: [
        { text: "Активен", value: true },
        { text: "Неактивен", value: false },
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
      title: "Порядок",
      dataIndex: "sortOrder",
      key: "sortOrder",
      sorter: (a, b) => a.sortOrder - b.sortOrder,
    },
    {
      title: "Действия",
      key: "actions",
      render: (_, record) => (
        <Space>
          <Button
            icon={<EditOutlined />}
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              handleEdit(record);
            }}
          />
          <Popconfirm
            title="Удалить промпт?"
            description="Это действие нельзя отменить"
            onConfirm={() => handleDelete(record.id)}
            okText="Да"
            cancelText="Нет"
          >
            <Button
              icon={<DeleteOutlined />}
              size="small"
              danger
              onClick={(e) => e.stopPropagation()}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <Title level={4} style={{ margin: 0 }}>
          Промпты
        </Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
          Добавить
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={prompts}
        rowKey="id"
        loading={loading}
        pagination={pagination}
        onChange={handleTableChange}
      />

      <Modal
        title={editingPrompt ? "Редактировать промпт" : "Новый промпт"}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={saving}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="topic"
            label="Тема"
            rules={[{ required: true, message: "Введите тему" }]}
          >
            <Input placeholder="Например: Travel, Work, etc." />
          </Form.Item>

          <Form.Item name="textContent" label="Текст вопроса">
            <Input.TextArea
              rows={3}
              placeholder="Текстовое описание промпта (необязательно)"
            />
          </Form.Item>

          <Form.Item name="audioFileId" label="Audio File ID">
            <Input placeholder="Telegram Audio File ID (необязательно)" />
          </Form.Item>

          <Form.Item name="difficulty" label="Сложность">
            <Select options={DIFFICULTIES} />
          </Form.Item>

          <Form.Item name="tags" label="Теги">
            <Select
              mode="multiple"
              placeholder="Выберите теги"
              options={AVAILABLE_TAGS.map((tag) => ({ value: tag, label: tag }))}
            />
          </Form.Item>

          <Form.Item name="sortOrder" label="Порядок сортировки">
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>

          <Form.Item name="isActive" label="Активен" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
