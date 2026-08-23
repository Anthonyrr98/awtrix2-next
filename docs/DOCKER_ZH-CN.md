# Docker 一键部署

## 准备条件

- 一台安装了 Docker Engine 和 Docker Compose 插件的 Linux 主机。
- 一套合法获得的 AWTRIX2 Host 完整运行目录。
- 实体 AWTRIX2 屏幕；增强控制器固件可从 GitHub Release 下载。

## 安装

```bash
git clone https://github.com/Anthonyrr98/awtrix2-next.git
cd awtrix2-next
cp -a /你的/AWTRIX2-Host/. runtime/
chmod +x install.sh update.sh
./install.sh
```

打开 `http://服务器IP:7100/`。实体屏幕的 Host 地址填写这台服务器的局域网地址或公网地址。

## 端口

- `7000/TCP`：Host HTTP API，默认只绑定 `127.0.0.1`，不要直接暴露到公网。
- `7001/TCP`：实体屏幕连接端口。
- `7100/TCP`：AWTRIX2 Next 控制面板。

云服务器需要在安全组放行 `7001/TCP` 和实际对外使用的 Web 端口。推荐用 HTTPS 反向代理保护控制面板，不要将无认证的管理接口直接暴露给所有来源。

## 配置

首次运行会从 `.env.example` 生成 `.env`。可以修改时区、监听地址、面板端口和 GIF 最长播放时间。

```bash
docker compose config
docker compose ps
docker compose logs -f
```

## 更新与备份

```bash
./update.sh
tar -czf awtrix2-next-backup.tar.gz runtime .env
```

`runtime/config` 以及 Bridge 的 Docker 数据卷保存运行数据。设备完整闪存备份可能包含 Wi-Fi 密码，应始终私下保存，不要提交到 GitHub。

