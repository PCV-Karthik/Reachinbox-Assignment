
# Reachinbox-Assignment

A brief description on how to setup the application locally

## Prerequisites

Before you start, make sure you have these installed:

- Node.js and npm: You can download these from here.
- Docker: You can download it from here.
- Redis: We will run this using Docker.

## Steps to Setup
### 1. Clone the application

``` 
git clone https://github.com/PCV-Karthik/Reachinbox-Assignment

```
Replace username with your GitHub username.

### 2. Install Dependencies
Navigate to the root directory of your project and install the necessary dependencies by running:

``` 
npm install
```

### 3. Install Dependencies
We will use Docker to run the Redis server. Execute the following command:
``` 
docker run -itd -p 6379:6379 redis
```
This command pulls the Redis image from Docker Hub and runs it locally on port 6379.

### 4. Start the Application
Now, you can start the application by running:

``` 
npm start 
```

Your application should now be running locally. If an environment file (.env) is needed, make sure to create one in the root directory of the project and populate it with necessary environment variables.

### 5. View the Webpage Locally
If your application includes a frontend that can be accessed via a web browser, you can open the main.html file in your web browser to view it. If your application is running on a server (like an Express.js server), it might be accessible at a URL like http://localhost:3000/frontend/main.html, where 3000 should be replaced with the port your server is running on.
