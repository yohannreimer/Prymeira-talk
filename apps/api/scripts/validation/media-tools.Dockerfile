# Same media packages as the production API; independent of the host's APT mirrors.
FROM node:22-alpine
RUN apk add --no-cache ffmpeg poppler-utils fontconfig font-liberation font-dejavu \
  && fc-cache -f \
  && test -n "$(fc-match -f '%{file}' Helvetica)"
