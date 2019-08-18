const _ = require('lodash');
const Telegraf = require('telegraf');
const sharp = require('sharp');
const captcha = require('svg-captcha');
const md5 = require('md5');
const dayjs = require('dayjs');
const Markup = require('telegraf/markup');
const genfun = require('generate-function');
const Redis = require('ioredis');

const redis = new Redis(
  {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
  },
);

const { d } = genfun.formats;

const handleDeleteMessage = (ctx, replyAnswerMessage) => {
  setTimeout(
    (
      (context, replyAnswerMessageContext) => () => {
        const userReplyMessageId = _.get(replyAnswerMessageContext, 'message_id');

        context.deleteMessage(userReplyMessageId);
      }
    )(ctx, replyAnswerMessage),
    30000,
  );
};

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.on('new_chat_members', async (ctx) => {
  const newChatMember = _.get(ctx, 'message.new_chat_member');
  const newChatMemberId = _.get(newChatMember, 'id');
  const firstName = _.get(newChatMember, 'first_name', '');
  const lastName = _.get(newChatMember, 'last_name', '');
  const user = _.get(ctx, 'from');
  const userId = _.get(user, 'id');
  const chat = _.get(ctx, 'chat');
  const chatId = _.get(chat, 'id');
  const name = `${firstName} ${lastName}`.trim();

  if (userId === newChatMemberId) {
    await ctx.telegram.callApi(
      'restrictChatMember',
      {
        chat_id: chatId,
        user_id: newChatMemberId,
        permissions: {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
          can_change_info: false,
          can_invite_users: false,
          can_pin_messages: false,
        },
      },
    );

    const messages = await redis.smembers(`app:tg-captcha:chat:${chatId}:user:${newChatMemberId}:messages`);

    await Promise.all(
      messages
        .filter(Boolean)
        .map(
          (messageId) => ctx.deleteMessage(messageId),
        ),
    );

    const formula = (
      [
        numberA,
        operatorA,
        numberB,
        operatorB,
        numberC,
      ],
    ) => {
      const gen = genfun();

      gen(`
      function () {
        return ${d(numberA)} ${operatorA} ${d(numberB)} ${operatorB} ${d(numberC)};
      }
    `);

      return gen.toFunction();
    };

    const calculateTotalCache = [];
    const questions = Array(3)
      .fill()
      .map(() => {
        const getRandomNumber = () => {
          const randomNumber = Array(5)
            .fill()
            .reduce(
              (current, value, index) => {
                const operators = [
                  '+',
                  '-',
                  '*',
                ];

                if (index % 2 === 0) {
                  current.push(_.random(0, 99));
                } else {
                  current.push(operators[_.random(0, operators.length - 1)]);
                }

                return current;
              },
              [],
            );

          const total = formula(randomNumber)();

          if (calculateTotalCache.includes(total)) {
            return getRandomNumber();
          }

          calculateTotalCache.push(total);

          return {
            total,
            formula: randomNumber,
          };
        };

        const hash = md5(`${dayjs().valueOf()}${_.random(0, 100)}`);

        return {
          randomNumber: getRandomNumber(),
          hash,
        };
      });

    const answer = questions[_.random(0, questions.length - 1)];

    await redis.set(`app:tg-captcha:chat:${chatId}:user:${newChatMemberId}`, answer.hash);
    const replyQuestionMessage = await ctx.replyWithPhoto(
      {
        source: await sharp(Buffer.from(captcha(answer.randomNumber.formula.join(' '))))
          .flatten({ background: '#ffffff' })
          .resize(800)
          .toFormat('jpg')
          .toBuffer(),
      },
      {
        reply_markup: Markup.inlineKeyboard(
          questions.map(
            (question) => Markup.callbackButton(question.randomNumber.total, question.hash),
          ),
        ),
        caption: `👏 歡迎新使用者 ${name}，請在180秒內回答圖片的問題，否則牧羊犬會趕你出去喔 🐶`,
        reply_to_message_id: ctx.message.message_id,
      },
    );

    setTimeout(
      (
        (context, replyQuestionMessageContext) => async () => {
          const requestUserId = _.get(context, 'message.new_chat_member');
          const requestChatId = _.get(context, 'chat.id');
          const userQuestionReplyMessageId = _.get(replyQuestionMessageContext, 'message_id');

          await context.deleteMessage(userQuestionReplyMessageId);
          const hash = await redis.get(`app:tg-captcha:chat:${requestUserId}:user:${requestChatId}`);

          if (hash) {
            await context.kickChatMember(requestUserId);

            const replyAnswerMessage = await context.reply(
              '❌ 因為超過180秒回答，所以牧羊犬把你吃掉了',
              {
                reply_to_message_id: context.message.message_id,
              },
            );
            await redis.del(`app:tg-captcha:chat:${requestChatId}:user:${requestUserId}`);

            handleDeleteMessage(context, replyAnswerMessage);
          }
        }
      )(ctx, replyQuestionMessage),
      180000,
    );
  }
});

bot.action(/.+/, async (ctx) => {
  const userId = _.get(ctx, 'from.id');
  const chatId = _.get(ctx, 'chat.id');
  const callback = _.get(ctx, 'update.callback_query.message');
  const messageId = _.get(callback, 'message_id');
  const replyMessage = _.get(callback, 'reply_to_message');
  const replyMessageId = _.get(replyMessage, 'message_id');
  const challengeId = _.get(replyMessage, 'new_chat_member.id');
  const [inlineButton] = _.get(ctx, 'match', []);

  let replyAnswerMessage = null;

  const captchaAnswer = await redis.get(`app:tg-captcha:chat:${chatId}:user:${userId}`);

  if (userId !== challengeId) {
    ctx.answerCbQuery('這不是你的按鈕，請不要亂點 😠');
  } else if (captchaAnswer === inlineButton) {
    await ctx.deleteMessage(messageId);

    replyAnswerMessage = await ctx.reply(
      '⭕️ 恭喜回答正確，牧羊犬歡迎你的加入~',
      {
        reply_to_message_id: replyMessageId,
      },
    );

    await ctx.telegram.callApi(
      'restrictChatMember',
      {
        chat_id: chatId,
        user_id: userId,
        permissions: {
          can_send_messages: true,
          can_send_media_messages: true,
          can_send_polls: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
          can_change_info: true,
          can_invite_users: true,
          can_pin_messages: true,
        },
      },
    );
  } else {
    replyAnswerMessage = await ctx.reply(
      '❌ 回答失敗，所以牧羊犬把你吃掉了',
      {
        reply_to_message_id: replyMessageId,
      },
    );

    await ctx.kickChatMember(userId);
  }

  if (replyAnswerMessage) {
    await redis.del(`app:tg-captcha:chat:${chatId}:user:${userId}`);

    handleDeleteMessage(ctx, replyAnswerMessage);
  }
});

bot.on('message', async (ctx) => {
  const userId = _.get(ctx, 'message.from.id');
  const text = _.get(ctx, 'message.text');
  const messageId = _.get(ctx, 'message.message_id');
  const chatId = _.get(ctx, 'chat.id');
  const key = `app:tg-captcha:chat:${chatId}:user:${userId}:messages`;

  if (text) {
    await redis
      .pipeline()
      .sadd(key, messageId)
      .expire(key, 60)
      .exec();
  }
});

bot.catch(console.log);

bot.launch();
