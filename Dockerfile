FROM node:10-alpine

COPY . /base

WORKDIR /base

RUN npm install --global pnpm@^3 && \
  pnpm install --prod

ENTRYPOINT [ "pnpm", "start" ]