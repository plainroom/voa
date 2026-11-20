import type { DbAttachment } from "@/services/db/attachments";
import type { DbMessage } from "@/services/db/messages";
import { FlightCardFor } from "./FlightCard";
import { InviteCardFor } from "./InviteCard";

/** What every card gets: the message, its attachments, and whether it is open in the reader. */
export type CardProps = { message: DbMessage; attachments: DbAttachment[]; open: boolean };

/**
 * The cards over a message: what it is (a flight, an invite) and what to do with it. Each card
 * finds its own data (a task of the model, a file attached) and shows nothing when it has none;
 * a new card is one more line here.
 */
const CARDS = [InviteCardFor, FlightCardFor];

export function MailCards(props: CardProps) {
  return (
    <>
      {CARDS.map((Card, i) => (
        <Card key={i} {...props} />
      ))}
    </>
  );
}
