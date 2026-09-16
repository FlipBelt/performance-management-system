# 绩效管理系统

飞途行远内部绩效管理系统，覆盖 KPI 与 OKR 目标制定、员工确认、直属上级审核、BP 复核、绩效评分、签字归档、钉钉通知及部门权限控制。

## 运行环境

- Node.js 20+
- 持久化数据目录由 `DATA_DIR` 指定
- 钉钉、管理员密码及链接签名密钥通过环境变量配置

```bash
npm ci
cp .env.deploy.example .env
npm start
```

详细环境变量、部署方式和验收步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 测试

项目测试位于 `outputs/test-*.js`。例如：

```bash
node outputs/test-access-control.js
node outputs/test-target-authoring-flow.js
node outputs/test-okr-parallel-flow.js
```

## 安全说明

仓库只保存源码和无密钥示例配置，不包含生产账号密码、钉钉密钥、员工运行数据、签字归档、通知队列、日志、浏览器配置或服务器私钥。生产配置必须保存在服务器环境变量或受控的密钥管理系统中。
