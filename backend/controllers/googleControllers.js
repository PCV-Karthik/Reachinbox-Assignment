const { google } = require("googleapis");
const axios = require("axios");
const dotenv = require("dotenv");
const { transport } = require("../utils/mail");
const {init} = require("../utils/producer");
const Bottleneck = require('bottleneck');
dotenv.config();


const { Worker } = require("bullmq");

const oAuth2Client = new google.auth.OAuth2({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI,
});

const scopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
];

const redirectToGoogleConsent = (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
  });
  res.redirect(authUrl);
};

const getListOfMails = async (tokens) => {
  try {
    const response = await axios({
      method: "get",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100",
      format: "full",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });
    return response.data;
  } catch (error) {
    console.log(error);
  }
};

const getMail = async (id, tokens) => {
  try {
    const mail = await axios({
      method: "get",
      url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`,
      format: "full",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });

    return mail;
  } catch (error) {
    console.log(error);
  }
};

const parseMail = (mail) => {
  const payload = mail.data.payload;
  const headers = payload.headers;
  const subject = headers.find((header) => header.name === "Subject")?.value;

  const from = headers.find((header) => header.name === "From")?.value;

  const pattern = /([^<]*)<([^>]*)>/;

  const result = pattern.exec(from);
  const fromName = result[1].trim();
  const fromEmail = result[2].trim();

  const to = headers.find((header) => header.name === "To")?.value;
  const cc = headers.find((header) => header.name === "Cc")?.value;

  let textContent = "";
  if (payload.parts) {
    const textPart = payload.parts.find(
      (part) => part.mimeType === "text/plain"
    );
    if (textPart) {
      textContent = Buffer.from(textPart.body.data, "base64").toString("utf-8");
    }
  } else {
    textContent = Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  const emailContext = `${subject} ${textContent} `;

  const parseObject = {
    subject,
    textContent,
    emailContext,
    from: {
      name: fromName,
      email: fromEmail,
    },
    to,
    cc,
  };
  return parseObject;
};

const limiter = new Bottleneck({
  minTime: 2000
});

const labelMail = async (parseObject) => {
  try {
    return await limiter.schedule(async () => {
      console.log("Waiting to start labelling mail");
      const emailContext = parseObject.emailContext;
      const { data } = await axios.request({
        method: "POST",
        url: "https://chatgpt-api8.p.rapidapi.com/",
        headers: {
          "content-type": "application/json",
          "X-RapidAPI-Key": process.env.RAPID_API_KEY,
          "X-RapidAPI-Host": "chatgpt-api8.p.rapidapi.com",
        },
        data: [
          {
            content: `based on the following text  just give one word answer, Categorizing the text based on the content and assign a label from the given options -
              Interested,
              Not Interested,
              More information. text is : ${emailContext}`,
            role: "user",
          },
        ],
      });
      return data.text;
    });
  } catch (error) {
    console.log(error);
  }
};

const writeMail = async (request) => {
  try {
    return await limiter.schedule(async () => {
      console.log("Waiting to start writing mail")
      const { data } = await axios.request({
        method: "POST",
        url: "https://chatgpt-api8.p.rapidapi.com/",
        headers: {
          "content-type": "application/json",
          "X-RapidAPI-Key": process.env.RAPID_API_KEY,
          "X-RapidAPI-Host": "chatgpt-api8.p.rapidapi.com",
        },
        data: [
          {
            content: request,
            role: "user",
          },
        ],
      });
      return data.text;
    });
  } catch (error) {
    console.log(error);
  }
};

const sendMail = (details) => {
  transport().sendMail({
    from: "emailverification@email.com",
    to: details.to,
    subject: `Reply to ${details.subject}`,
    html: `<p>${details.body}</p>`,
  });
};


const worker = new Worker("emailQueue", async (job) => {
  console.log(`Message rec id: ${job.id}`);
  console.log("Processing message");
  console.log(`Sending email to ${job.data.details.to}`);
  sendMail(job.data.details);
  console.log("Email sent");
}, {
  connection: {
    host: "127.0.0.1",
    port: "6379",
  },
});

const googleCallback = async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send("Authorization code missing.");
  }
  try {
    oAuth2Client.getToken(code, async function (err, tokens) {
      if (err) {
        console.error("Error getting oAuth tokens:", err);
      }
      oAuth2Client.setCredentials(tokens);

      const data = await getListOfMails(tokens);
      const messages = data.messages;
      console.log(messages.length);
      messages.forEach(async (message) => {
        await limiter.schedule(async () => {
        const id = message.id;
        const mail = await getMail(id, tokens);
        const parsedMail = parseMail(mail);
        console.log(parsedMail);
        const label = await labelMail(parsedMail);
        console.log(label);
        let request = "";
        switch (label) {
          case "Interested":
            request = `Read ${parsedMail.emailContext} and write an email on behalf of Raj, Manager, Reachinbox asking ${parsedMail.from.name}  if they are willing to hop on to a demo call by suggesting a time from Raj`;
            break;
          case "Not Interested":
            request = `Read ${parsedMail.emailContext} and write an email on behalf of Raj, Manager, Reachinbox thanking ${parsedMail.from.name} for their time and asking them if they would like to be contacted in the future from Raj`;
            break;
          case "More information":
            request = `Read ${parsedMail.emailContext} and write an email on behalf of Raj, Manager, Reachinbox asking ${parsedMail.from.name} if they would like more information about the product from Raj`;
            break;
          default:
            request = `Read ${parsedMail.emailContext} and write an email on behalf of Raj, Manager, Reachinbox asking ${parsedMail.from.name} if they are willing to hop on to a demo call by suggesting a time Raj`;
        }
  
        const body = await writeMail(request);
        const details = {
          to: parsedMail.from.email,
          cc: parsedMail.cc,
          subject: parsedMail.subject,
          body: body,
        };
        init(details);
      });
    });
      res.send(
        `You have successfully authenticated with Google and Sent Replies to your Email. You can now close this tab.`
      );
    });
  } catch (error) {
    console.log(error);
  }
};

module.exports = { redirectToGoogleConsent, googleCallback };
