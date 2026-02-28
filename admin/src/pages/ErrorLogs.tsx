import { useEffect, useState } from "react";
import {
  Table,
  Typography,
  Tag,
  Button,
  Space,
  Select,
  Modal,
  message,
  Popconfirm,
} from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { DeleteOutlined, EyeOutlined } from "@ant-design/icons";
import { adminApi } from "../api/admin.api";
import type { ErrorLogItem } from "../types";

const { Title, Text, Paragraph } = Typography;

const ERROR_TYPES = [
  { value: "ai", label: "AI" },
  { value: "telegram", label: "Telegram" },
  { value: "system", label: "Система" },
];

const ERROR_SERVICES = [
  { value: "whisper", label: "Whisper" },
  { value: "llm", label: "LLM" },
  { value: "tts", label: "TTS" },
  { value: "telegram", label: "Telegram" },
  { value: "scheduler", label: "Планировщик" },
  { value: "general", label: "Общее" },
];

export function ErrorLogs() {
  const [logs, setLogs] = useState<ErrorLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState<TablePaginationConfig>({
    current: 1,
    pageSize: 50,
    total: 0,
  });
  const [typeFilter, setTypeFilter] = useState<string | undefined>();
  const [serviceFilter, setServiceFilter] = useState<string | undefined>();
  const [selectedLog, setSelectedLog] = useState<ErrorLogItem | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);

  useEffect(() => {
    loadLogs(1, 50);
  }, [typeFilter, serviceFilter]);

  const loadLogs = async (page: number, limit: number) => {
    setLoading(true);
    try {
      const data = await adminApi.getErrorLogs(
        page,
        limit,
        typeFilter,
        serviceFilter
      );
      setLogs(data.data);
      setPagination({
        current: data.page,
        pageSize: data.limit,
        total: data.total,
      });
    } catch {
      message.error("Не удалось загрузить логи");
    } finally {
      setLoading(false);
    }
  };

  const handleTableChange = (newPagination: TablePaginationConfig) => {
    loadLogs(newPagination.current || 1, newPagination.pageSize || 50);
  };

  const handleClearOld = async () => {
    try {
      const result = await adminApi.clearOldErrorLogs(30);
      message.success(`Удалено ${result.deleted} записей`);
      loadLogs(pagination.current || 1, pagination.pageSize || 50);
    } catch {
      message.error("Не удалось удалить записи");
    }
  };

  const showDetail = (log: ErrorLogItem) => {
    setSelectedLog(log);
    setDetailModalOpen(true);
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case "ai":
        return "purple";
      case "telegram":
        return "blue";
      case "system":
        return "red";
      default:
        return "default";
    }
  };

  const getServiceColor = (service: string) => {
    switch (service) {
      case "whisper":
        return "cyan";
      case "llm":
        return "magenta";
      case "tts":
        return "orange";
      case "telegram":
        return "blue";
      case "scheduler":
        return "green";
      default:
        return "default";
    }
  };

  const columns: ColumnsType<ErrorLogItem> = [
    {
      title: "Дата",
      dataIndex: "createdAt",
      key: "createdAt",
      render: (date: string) => new Date(date).toLocaleString("ru-RU"),
      width: 160,
    },
    {
      title: "Тип",
      dataIndex: "type",
      key: "type",
      render: (type: string) => (
        <Tag color={getTypeColor(type)}>{type.toUpperCase()}</Tag>
      ),
      width: 100,
    },
    {
      title: "Сервис",
      dataIndex: "service",
      key: "service",
      render: (service: string) => (
        <Tag color={getServiceColor(service)}>{service}</Tag>
      ),
      width: 120,
    },
    {
      title: "Сообщение",
      dataIndex: "message",
      key: "message",
      ellipsis: true,
    },
    {
      title: "User ID",
      dataIndex: "userId",
      key: "userId",
      render: (userId: string | null) => userId || "-",
      width: 100,
      ellipsis: true,
    },
    {
      title: "",
      key: "actions",
      width: 50,
      render: (_, record) => (
        <Button
          icon={<EyeOutlined />}
          size="small"
          onClick={() => showDetail(record)}
        />
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
          Логи ошибок
        </Title>
        <Space>
          <Select
            placeholder="Тип"
            allowClear
            style={{ width: 120 }}
            value={typeFilter}
            onChange={setTypeFilter}
            options={ERROR_TYPES}
          />
          <Select
            placeholder="Сервис"
            allowClear
            style={{ width: 140 }}
            value={serviceFilter}
            onChange={setServiceFilter}
            options={ERROR_SERVICES}
          />
          <Popconfirm
            title="Очистить старые логи?"
            description="Будут удалены логи старше 30 дней"
            onConfirm={handleClearOld}
            okText="Да"
            cancelText="Нет"
          >
            <Button icon={<DeleteOutlined />} danger>
              Очистить старые
            </Button>
          </Popconfirm>
        </Space>
      </div>

      <Table
        columns={columns}
        dataSource={logs}
        rowKey="id"
        loading={loading}
        pagination={pagination}
        onChange={handleTableChange}
        size="small"
      />

      <Modal
        title="Детали ошибки"
        open={detailModalOpen}
        onCancel={() => setDetailModalOpen(false)}
        footer={null}
        width={700}
      >
        {selectedLog && (
          <div>
            <Space direction="vertical" style={{ width: "100%" }} size="middle">
              <div>
                <Text strong>Дата: </Text>
                <Text>
                  {new Date(selectedLog.createdAt).toLocaleString("ru-RU")}
                </Text>
              </div>
              <div>
                <Text strong>Тип: </Text>
                <Tag color={getTypeColor(selectedLog.type)}>
                  {selectedLog.type.toUpperCase()}
                </Tag>
              </div>
              <div>
                <Text strong>Сервис: </Text>
                <Tag color={getServiceColor(selectedLog.service)}>
                  {selectedLog.service}
                </Tag>
              </div>
              {selectedLog.userId && (
                <div>
                  <Text strong>User ID: </Text>
                  <Text code>{selectedLog.userId}</Text>
                </div>
              )}
              <div>
                <Text strong>Сообщение:</Text>
                <Paragraph
                  style={{
                    background: "#f5f5f5",
                    padding: 12,
                    borderRadius: 4,
                    marginTop: 8,
                  }}
                >
                  {selectedLog.message}
                </Paragraph>
              </div>
              {selectedLog.stack && (
                <div>
                  <Text strong>Stack trace:</Text>
                  <pre
                    style={{
                      background: "#1e1e1e",
                      color: "#d4d4d4",
                      padding: 12,
                      borderRadius: 4,
                      marginTop: 8,
                      overflow: "auto",
                      maxHeight: 300,
                      fontSize: 12,
                    }}
                  >
                    {selectedLog.stack}
                  </pre>
                </div>
              )}
              {selectedLog.metadata != null && (
                <div>
                  <Text strong>Metadata:</Text>
                  <pre
                    style={{
                      background: "#f5f5f5",
                      padding: 12,
                      borderRadius: 4,
                      marginTop: 8,
                      overflow: "auto",
                      maxHeight: 200,
                      fontSize: 12,
                    }}
                  >
                    {JSON.stringify(selectedLog.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </Space>
          </div>
        )}
      </Modal>
    </div>
  );
}
