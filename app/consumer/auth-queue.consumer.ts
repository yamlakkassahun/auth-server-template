import { AuthActionType, ContextArgs, QueueConsumer, } from '@open-template-hub/common';

export class AuthQueueConsumer implements QueueConsumer {
  private channel: any;
  private ctxArgs: ContextArgs = {} as ContextArgs;

  init = ( channel: string, ctxArgs: ContextArgs ) => {
    this.channel = channel;
    this.ctxArgs = ctxArgs;
    return this;
  };

  onMessage = async ( msg: any ) => {
    if ( msg !== null ) {
      const msgStr = msg.content.toString();
      const msgObj = JSON.parse( msgStr );

      const message: AuthActionType = msgObj.message;

      // Decide requeue in the error handling
      let requeue = false;

      if ( message.example ) {
        const exampleHook = async () => {
          console.log( 'Auth server example' );
        };

        await this.operate( msg, msgObj, requeue, exampleHook );
      } else {
        console.log( 'Message will be rejected: ', msgObj );
        this.channel.reject( msg, false );
      }
    }
  };

  private operate = async (
      msg: any,
      msgObj: any,
      requeue: boolean,
      hook: Function
  ) => {
    try {
      console.log(
          'Message Received with deliveryTag: ' + msg.fields.deliveryTag,
          msgObj
      );
      await hook();
      await this.channel.ack( msg );
      console.log(
          'Message Processed with deliveryTag: ' + msg.fields.deliveryTag,
          msgObj
      );
    } catch ( e ) {
      console.log(
          'Error with processing deliveryTag: ' + msg.fields.deliveryTag,
          msgObj,
          e
      );

      this.channel.nack( msg, false, requeue );
    }
  };
}
