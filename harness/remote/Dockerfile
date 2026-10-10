# 使用一个基础镜像，例如 Ubuntu
FROM ubuntu:22.04

# 安装 openssh-server
RUN apt-get update && apt-get install -y openssh-server

# 创建 ssh 目录
RUN mkdir /var/run/sshd

# 设置 root 密码并允许 root 密码登录（仅用于测试）
RUN echo 'root:root' | chpasswd
RUN sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config

# 创建 dev 用户
RUN useradd -m -s /bin/bash dev && echo 'dev:dev' | chpasswd

# 不清理环境变量，防止 ssh 登录时报错
RUN sed -i 's@session\s*required\s*pam_loginuid.so@session optional pam_loginuid.so@g' /etc/pam.d/sshd

# 暴露 ssh 默认端口
EXPOSE 22

# 启动 ssh 服务
CMD ["/usr/sbin/sshd", "-D"]