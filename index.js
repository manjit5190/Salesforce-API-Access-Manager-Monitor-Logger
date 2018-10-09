process.env.NODE_TLS_REJECT_UNAUTHORIZED = false;
console.log('Loading function');

const doc = require('dynamodb-doc');
const axios = require('axios');
const queryString = require('querystring');
const aws = require('aws-sdk');
// Add your access token and secret if you are going to be the
aws.config.region = process.env.SQS_REGION;
const SQS = new aws.SQS();


const dynamo = new doc.DynamoDB();
const API_GATEWAY_BASE_PATH = '/salesforce';
const SALESFORCE_LOGIN_URL = 'https://login.salesforce.com/services/oauth2/token';
const SALESFORCE_LOG_URL = '/services/data/v42.0/sobjects/' + process.env.SALESFORCE_LOG_OBJECT_NAME;

let SALESFORCE_BASE_URL;
let SALESFORCE_ACCESS_TOKEN;

/**
 * Demonstrates a simple HTTP endpoint using API Gateway. You have full
 * access to the request and response payload, including headers and
 * status code.
 *
 * To scan a DynamoDB table, make a GET request with the TableName as a
 * query string parameter. To put, update, or delete an item, make a POST,
 * PUT, or DELETE request respectively, passing in the payload to the
 * DynamoDB API as a JSON body.
 */
exports.handler = (event, context, callback) => {
    if (process.env.ENABLE_LOGGING) {
        console.log('Received event:', JSON.stringify(event, null, 2));
        console.log('Received context:', JSON.stringify(context, null, 2));
    }

    function done(response, isError) {
        let awsResponse = {
            statusCode: response.status,
            body: isError ? response.data : JSON.stringify(response.data),
        };

        awsResponse.headers = {};

        Object.keys(response.headers).forEach(function (value) {
            //set-cookie headers starts as an array which causes problems.
            if (value !== 'set-cookie') {
                awsResponse.headers[value] = response.headers[value];
            }
        });

        console.log(awsResponse);
        return awsResponse;
    }

    function handleRequest() {
        let SF_RESPONSE;
        console.log('In handle Request');
        return axios.post(SALESFORCE_LOGIN_URL, queryString.stringify(
            {
                grant_type: "password",
                username: process.env.USERNAME,
                password: process.env.PASSWORD + process.env.SECURITY_TOKEN,
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET
            })
        )
            .then(function (response) {
                console.log('Received Access Token' + JSON.stringify(response.data));
                SALESFORCE_ACCESS_TOKEN = SALESFORCE_ACCESS_TOKEN || response.data.access_token;
                SALESFORCE_BASE_URL = SALESFORCE_BASE_URL || response.data.instance_url;
                event.headers.Authorization = 'Bearer ' + SALESFORCE_ACCESS_TOKEN;

                let configuration = {
                    method: event.httpMethod.toUpperCase(),
                    url: SALESFORCE_BASE_URL + event.path.replace(API_GATEWAY_BASE_PATH, ''),
                    headers: event.headers
                };

                if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
                    configuration.data = event.body;
                    configuration.headers["Content-Type"] = "application/json";
                }
                console.log(JSON.stringify(configuration));
                return axios(configuration);
            })
            .then(function (response) {
                if (process.env.PUSH_TO_SQS) {
                    let params = {
                        MessageBody: JSON.stringify(getEventBody().Item),
                        QueueUrl: process.env.SQS_QUEUE_URL,
                        DelaySeconds: 0
                    };
                    console.log("--PARAMS--");
                    SQS.sendMessage(params);
                }
                if (process.env.LOG_TO_DYNAMO_DB) {
                    dynamo.putItem(getEventBody(), function (err, data) {
                        console.log(err, data);
                    });
                }
                SF_RESPONSE = response;
                return response;
            })
            .then(function (response) {
                if (process.env.LOG_TO_SALESFORCE) {
                    return axios({
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + SALESFORCE_ACCESS_TOKEN
                        },
                        data: {
                            "Name": event.headers.customerkey,
                            "gmsd__Item__c": JSON.stringify(getEventBody())
                        },
                        url: SALESFORCE_BASE_URL + SALESFORCE_LOG_URL,
                    })

                }
            })
            .then(function (response) {
                return callback(null, done(SF_RESPONSE, false));
            })
            .catch(function (error) {
                console.log('Rejected' + error);
                if (process.env.LOG_TO_DYNAMO_DB) {
                    dynamo.putItem(getEventBody(), function () {
                        return callback(null, done(error.response, true));
                    });
                }
            })
    }

    function getEventBody() {
        console.log('Logging Body');
        return {
            "TableName": process.env.DYNAMO_LOGGING_TABLE_NAME,
            "Item": {
                "CustomeyKey": event.headers.customerkey + '_' + context.awsRequestId,
                "details": JSON.stringify(event, null, 2)
            }
        }
    }

    function checkAccessToSalesforceResourceAndHandleRequest() {
        let PATH = event.path.split('/');
        let objectName;
        PATH.forEach(function (value, index) {
            if (value === 'sobjects') {
                objectName = PATH[index + 1];
                return null;
            }
        });
        if (objectName) {
            var params = {
                TableName: process.env.DYNAMO_ACCESS_TABLE_NAME,
                FilterExpression: "CustomerKey = :CKey",
                ExpressionAttributeValues: {
                    ":CKey": event.headers.customerkey,
                }
            };
            console.log(JSON.stringify(params));
            dynamo.scan(params, onScan);

            function onScan(err, data) {

                console.log("Scan succeeded." + JSON.stringify(data));

                if (data && (data.Count > 0) && data.Items[0][event.httpMethod] &&
                    data.Items[0][event.httpMethod].includes(objectName)) {
                    return handleRequest();
                } else {
                    callback(null, {
                        statusCode: '400',
                        body: `Sorry, you are not authorized to access resource at: "${event.path}."`
                            + "Please check with API Manager at : manjit5190@gmail.com",
                        headers: {
                            'Content-Type': 'application/json',
                        }
                    });
                }
            }
        }
    }

    switch (event.httpMethod) {

        case 'DELETE':
        case 'GET':
        case 'POST':
        case 'PUT':
        case 'PATCH':
            checkAccessToSalesforceResourceAndHandleRequest();
            break;
        default:
            callback(null, {
                statusCode: '400',
                body: `Unsupported method "${event.httpMethod}"`,
                headers: {
                    'Content-Type': 'application/json',
                }
            });
    }
};
