# 绩效管理系统部署说明

项目已整理为单个 Node.js Web 服务：系统首页、绩效 API、确认页和钉钉发送均由同一域名提供。

## 推荐配置

- 运行时：Docker / Node.js 20+
- 健康检查：`GET /ping`
- 持久化目录：`/var/data`
- 对外端口：使用平台提供的 `PORT`
- HTTPS：由托管平台或反向代理终止

## 必填环境变量

| 变量 | 说明 |
| --- | --- |
| `PUBLIC_SERVER_URL` | 最终 HTTPS 地址，不带末尾斜杠 |
| `DINGTALK_APP_KEY` | 钉钉企业内部应用 AppKey |
| `DINGTALK_APP_SECRET` | 钉钉应用密钥，仅保存在服务端 |
| `DINGTALK_ROBOT_CODE` | 钉钉机器人 RobotCode |
| `ADMIN_PASSWORD` | 系统看板管理员密码，生产环境强制要求 |
| `LINK_SIGNING_SECRET` | 确认页链接签名密钥，生产环境强制要求 |

可选变量：`ADMIN_USERNAME`（默认 `admin`）、`DATA_DIR`（Docker 默认 `/var/data`）。

## Render Blueprint

仓库根目录已经提供 `render.yaml` 和 `Dockerfile`。在 Render 创建 Blueprint 后：

1. 填写三个钉钉环境变量。
2. 首次部署完成后，把 `PUBLIC_SERVER_URL` 设置为 Render 分配的 HTTPS 地址并重新部署。
3. 持久化磁盘挂载在 `/var/data`；不要创建多个实例，否则 JSON 文件会出现并发写入问题。
4. 打开系统地址时使用平台生成的管理员用户名和密码。

## 上线验收

1. `/ping` 返回 `status: ok`，且 `delivery.ready` 为 `true`。
2. 管理首页会弹出登录框；未登录不能读取全员绩效数据。
3. 直接删除钉钉链接中的 `token` 参数后访问，应返回 403。
4. 仅选择一名测试员工提交 KPI，确认其钉钉收到 HTTPS 链接。
5. 完成 KPI 确认、自评、上级评分、BP 核准、结果确认全流程。
6. 重启服务并确认已提交数据仍存在。

生产环境应使用新的 AppSecret；不要把本地 `outputs/dingtalk_config.json` 上传到代码仓库或镜像。
