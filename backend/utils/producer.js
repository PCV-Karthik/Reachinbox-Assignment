const { Queue } = require("bullmq");

const emailQueue = new Queue("emailQueue", {
  connection: {
    host: "127.0.0.1",
    port: "6379",
  },
});

const init = async (details) => {
  const res = await emailQueue.add("sendEmail", {
    details: details,
  });
  console.log("Email added to queue", res.id);
};

module.exports = { init };
