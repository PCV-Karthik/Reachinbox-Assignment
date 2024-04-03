const { google } = require("googleapis");
const axios = require("axios");
const dotenv = require("dotenv");
const {transport} = require("../utils/mail");
const { init } = require("../utils/producer");
const Bottleneck = require("bottleneck");
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
    const response = await axios.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      }
    );
    return response.data.messages;
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

  const parseObject = {
    subject,
    textContent,
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
  minTime: 2000,
});

const getCurrentLabels = async (tokens) => {
  try {
    console.log("Waiting to start getting labels");
    const { data } = await axios.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      }
    );
    return data;
  } catch (error) {
    console.log(error.message);
  }
};

const labelAndReplyMail = async (mail) => {
  try {
    const { data } = await axios.request({
      method: "POST",
      url: 'https://chatgpt-api8.p.rapidapi.com/',
      headers: {
        'content-type': 'application/json',
        'X-RapidAPI-Key': process.env.X_RapidAPI_Key,
        'X-RapidAPI-Host': 'chatgpt-api8.p.rapidapi.com'
      },    
      data: [
          {
            content: `From the given text categorise the data into a single world ans. It can be Interested, Not interested, More information 
  
          text : ${mail.textContent},
          
          Based on that word write a reply, just the subject and body to ${mail.from.name} following the below rules:
          if Interested: write an email on behalf of Raj, Manager, Reachinbox asking ${mail.from.name}  if they are willing to hop on to a demo call by suggesting a time.
          if Not Interested: write an email on behalf of Raj, Manager, Reachinbox thanking ${mail.from.name} for their time and asking them if they would like to be contacted in the future from Raj
          if More Information : write an email on behalf of Raj, Manager, Reachinbox asking ${mail.from.name} if they would like more information about the product from Raj. 
          And i need information in the following json format only.
          {
          "label" : Label,
          "subject":Subject,
          "body":body,
          }
          `,
            role: "user",
          },
        ],
    });

    let text = data.text;
    const response = JSON.parse(text);
    return response;
  } catch (error) {
    console.log(error);
  }
};

const moveMailToLabel = async (id, labelId, tokens) => {
  try {
    console.log("Waiting to start moving mail to label");
    const { data } = await axios.post(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`,
      {
        addLabelIds: [labelId],
        removeLabelIds: ["INBOX"],
      },
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      }
    );
    console.log(`Mail moved to ${labelId} label`);
    return data;
  } catch (error) {
    console.log(error.message);
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

const worker = new Worker(
  "emailQueue",
  async (job) => {
    console.log(`Message rec id: ${job.id}`);
    console.log("Processing message");
    console.log(`Sending email to ${job.data.details.to}`);
    sendMail(job.data.details);
    console.log("Email sent");
  },
  {
    connection: {
      host: "127.0.0.1",
      port: "6379",
    },
  }
);

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

      const messages = await getListOfMails(tokens);
      let currentLabels = await getCurrentLabels(tokens);

      const existingLabels = currentLabels.labels.reduce(
        (acc, label) => ({ ...acc, [label.name]: label.id }),
        {}
      );

      const labelsToCreate = [
        "Interested",
        "Not Interested",
        "More Information",
      ].filter((label) => !existingLabels.hasOwnProperty(label));

      const createLabelPromises = labelsToCreate.map(async (label) => {
        return axios.post(
          `https://gmail.googleapis.com/gmail/v1/users/me/labels`,
          {
            name: label,
          },
          {
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
            },
          }
        );
      });

      Promise.all(createLabelPromises).then((responses) => {
        currentLabels = getCurrentLabels(tokens);
        messages.forEach(async (message) => {
          await limiter.schedule(async () => {
            const id = message.id;
            const mail = await getMail(id, tokens);
            const parsedMail = parseMail(mail);
            const labelAndReply = await labelAndReplyMail(parsedMail);
            await moveMailToLabel(
              id,
              existingLabels[labelAndReply.label],
              tokens
            );
            const details = {
              to: parsedMail.from.email,
              cc: parsedMail.cc,
              subject: labelAndReply.subject,
              body: labelAndReply.body,
            };
            init(details);
          });
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
