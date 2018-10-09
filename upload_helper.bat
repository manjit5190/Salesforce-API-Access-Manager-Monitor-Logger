"C:\Program Files (x86)\WinZip\wzzip" -u ../SFAccessManager.zip * -r -P
aws lambda update-function-code --function-name arn:aws:lambda:us-east-2:746395938386:function:SalesforceResourceAccessManagementMicroService --zip-file fileb://../SFAccessManager.zip
aws lambda publish-version --function-name SalesforceResourceAccessManagementMicroService