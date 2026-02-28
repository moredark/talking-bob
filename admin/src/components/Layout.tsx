import { Layout as AntLayout, Menu, Button, theme } from "antd";
import {
  DashboardOutlined,
  UserOutlined,
  FileTextOutlined,
  LogoutOutlined,
  SoundOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useNavigate, useLocation, Outlet } from "react-router-dom";

const { Header, Sider, Content } = AntLayout;

interface LayoutProps {
  onLogout: () => void;
  username: string;
}

export function Layout({ onLogout, username }: LayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    token: { colorBgContainer, borderRadiusLG },
  } = theme.useToken();

  const menuItems = [
    {
      key: "/",
      icon: <DashboardOutlined />,
      label: "Дашборд",
    },
    {
      key: "/users",
      icon: <UserOutlined />,
      label: "Пользователи",
    },
    {
      key: "/prompts",
      icon: <SoundOutlined />,
      label: "Промпты",
    },
    {
      key: "/topics",
      icon: <FileTextOutlined />,
      label: "Статистика тем",
    },
    {
      key: "/error-logs",
      icon: <WarningOutlined />,
      label: "Логи ошибок",
    },
  ];

  return (
    <AntLayout style={{ minHeight: "100vh" }}>
      <Sider theme="light" breakpoint="lg" collapsedWidth="0">
        <div
          style={{
            height: 64,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: "bold",
            fontSize: 18,
          }}
        >
          Talking Bob
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <AntLayout>
        <Header
          style={{
            padding: "0 24px",
            background: colorBgContainer,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 16,
          }}
        >
          <span>{username}</span>
          <Button icon={<LogoutOutlined />} onClick={onLogout}>
            Выйти
          </Button>
        </Header>
        <Content
          style={{
            margin: 24,
            padding: 24,
            background: colorBgContainer,
            borderRadius: borderRadiusLG,
            minHeight: 280,
          }}
        >
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  );
}
